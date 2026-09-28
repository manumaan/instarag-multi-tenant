import { Construct } from 'constructs';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';

export interface StorageProps {
  /** Web origins allowed to PUT/GET presigned URLs directly against the bucket. */
  readonly webOrigins: string[];
  /** RETAIN data on stack deletion. Default false while the app is a skeleton. */
  readonly retainData: boolean;
  /** Lifecycle expiration for media objects. Undefined = keep forever (Phase 7 owns the setting UI). */
  readonly retentionDays?: number;
}

/**
 * S3 media store + DynamoDB tables.
 *
 * Single-user app: no user_id / tenant prefix anywhere. Media objects live at
 * media/{mediaId}/... and table items are keyed by media id alone.
 */
export class Storage extends Construct {
  readonly mediaBucket: s3.Bucket;
  readonly mediaTable: dynamodb.Table;
  readonly framesTable: dynamodb.Table;
  readonly savesTable: dynamodb.Table;
  readonly usageTable: dynamodb.Table;
  readonly invitesTable: dynamodb.Table;
  readonly jobsTable: dynamodb.Table;
  readonly connectionsTable: dynamodb.Table;
  readonly captionFactsTable: dynamodb.Table;
  readonly transcriptSegmentsTable: dynamodb.Table;
  readonly threadsTable: dynamodb.Table;
  readonly messagesTable: dynamodb.Table;

  /** Constant partition key value for the media recency index. */
  /** GSI on the media table: newest-first library listing. */
  static readonly CONNECTIONS_BY_USER = 'byUser';
  static readonly SAVES_BY_SAVED_AT = 'bySavedAt';
  static readonly SAVES_BY_MEDIA = 'byMedia';
  /** Sparse GSI: find an already-ingested reel by its permalink. */
  /** GSI on the jobs table: all jobs for one media item. */
  static readonly JOBS_BY_MEDIA = 'byMedia';
  /** GSI on the threads table: newest-first thread list. */
  static readonly THREADS_BY_CREATED_AT = 'byCreatedAt';

  constructor(scope: Construct, id: string, props: StorageProps) {
    super(scope, id);

    const removalPolicy = props.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    /**
     * Applied to every table holding something worth keeping, rather than
     * table by table, so one added later cannot quietly miss it. RETAIN and
     * PITR answer different questions: RETAIN keeps the table when the stack
     * goes, PITR is the only way back from a bad write or an accidental purge
     * inside a table that still exists. A test asserts the coverage.
     */
    const durable = {
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: props.retainData },
      removalPolicy,
    };

    this.mediaBucket = new s3.Bucket(this, 'MediaBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy,
      autoDeleteObjects: !props.retainData,
      /*
       * Retaining the bucket does not protect what is in it: an uploaded reel
       * has no other copy anywhere, so an overwrite or a stray delete is
       * final. Versioning is what makes those recoverable — and note it
       * changes delete semantics, so the rules below sweep old versions and
       * the delete markers left behind.
       */
      versioned: props.retainData,
      cors: [
        {
          allowedOrigins: props.webOrigins,
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET, s3.HttpMethods.HEAD],
          allowedHeaders: ['*'],
          exposedHeaders: ['ETag'],
          maxAge: 3000,
        },
      ],
      lifecycleRules: [
        { id: 'abort-incomplete-uploads', abortIncompleteMultipartUploadAfter: Duration.days(7) },
        // Lens query screenshots are used once, to search with. Nothing refers
        // to them afterwards, so they expire rather than accumulate.
        { id: 'lens-queries', prefix: 'lens/', expiration: Duration.days(1) },
        ...(props.retainData
          ? [
              // Long enough to notice and undo a mistake, short enough that old
              // versions of a 10 MB reel do not accumulate forever.
              { id: 'expire-old-versions', noncurrentVersionExpiration: Duration.days(30) },
              // A delete on a versioned bucket leaves a marker behind rather
              // than removing the key; this clears the ones with nothing under
              // them. Its own rule: S3 rejects it alongside an expiration.
              { id: 'expire-delete-markers', expiredObjectDeleteMarker: true },
            ]
          : []),
        ...(props.retentionDays
          ? [{ id: 'media-retention', prefix: 'media/', expiration: Duration.days(props.retentionDays) }]
          : []),
      ],
    });

    /*
     * Global content, keyed by the reel itself: the Instagram shortcode for a
     * pasted link, a uuid for an upload. No tenant column — two people who save
     * the same reel share this row, its frames and its index documents.
     *
     * No secondary indexes. The shortcode *is* the key, so deduplication is a
     * GetItem rather than a byPermalink query, and library recency belongs to
     * `saves` where it partitions by user instead of on a constant.
     */
    this.mediaTable = new dynamodb.Table(this, 'MediaTable', {
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      ...durable,
      // Feeds the WebSocket broadcaster: every status change is pushed to the UI.
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
    });
    // Library grid: one hot partition is fine for a single-user library.
    
    // One row per media item: hashtags, mentions, entities, places, language, cta.
    this.captionFactsTable = new dynamodb.Table(this, 'CaptionFactsTable', {
      partitionKey: { name: 'media_id', type: dynamodb.AttributeType.STRING },
      ...durable,
    });

    // One row per spoken segment, keyed like frames so a citation can point at
    // either and the player can seek to it.
    this.transcriptSegmentsTable = new dynamodb.Table(this, 'TranscriptSegmentsTable', {
      partitionKey: { name: 'media_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'start_ms', type: dynamodb.AttributeType.NUMBER },
      ...durable,
    });

    this.threadsTable = new dynamodb.Table(this, 'ThreadsTable', {
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      ...durable,
    });
    this.threadsTable.addGlobalSecondaryIndex({
      indexName: Storage.THREADS_BY_CREATED_AT,
      partitionKey: { name: 'entity', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'created_at', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // created_at as the sort key keeps a thread's turns in order.
    this.messagesTable = new dynamodb.Table(this, 'MessagesTable', {
      partitionKey: { name: 'thread_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'created_at', type: dynamodb.AttributeType.STRING },
      ...durable,
    });

    // Sparse: only items with a permalink appear, which is what makes a
    // re-paste of the same reel cheap to detect without scanning the library.
    
    this.framesTable = new dynamodb.Table(this, 'FramesTable', {
      partitionKey: { name: 'media_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'ts_ms', type: dynamodb.AttributeType.NUMBER },
      ...durable,
    });

    /*
     * Who has what. Content is global — one download, one analysis and one set
     * of index documents however many people save a reel — so this is the only
     * table that knows a library belongs to someone, and the only thing every
     * authorisation check reads.
     *
     * Partitioning on user_id also disposes of the single-user compromise this
     * replaces: media recency used to live on a GSI with a constant partition
     * key, which is one hot partition the moment there is a second person.
     */
    this.savesTable = new dynamodb.Table(this, 'SavesTable', {
      partitionKey: { name: 'user_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'media_id', type: dynamodb.AttributeType.STRING },
      ...durable,
    });
    // The library grid: one user's saves, newest first.
    this.savesTable.addGlobalSecondaryIndex({
      indexName: Storage.SAVES_BY_SAVED_AT,
      partitionKey: { name: 'user_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'saved_at', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    // Who to notify when a piece of content changes state.
    this.savesTable.addGlobalSecondaryIndex({
      indexName: Storage.SAVES_BY_MEDIA,
      partitionKey: { name: 'media_id', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.KEYS_ONLY,
    });

    /*
     * What each person has cost, per calendar month. Counters only, incremented
     * with ADD, so two handlers writing at once is normal rather than a
     * conflict.
     *
     * Durable like the rest: it is the basis of a quota and of any bill, and it
     * cannot be reconstructed after the fact — the CloudWatch metrics beside it
     * are aggregates with a retention window, not a per-person record.
     */
    this.usageTable = new dynamodb.Table(this, 'UsageTable', {
      partitionKey: { name: 'user_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'period', type: dynamodb.AttributeType.STRING },
      ...durable,
    });

    /*
     * Who invited whom, and when. Not the thing that grants access — Cognito is
     * the source of truth for whether an account exists — so this stays a plain
     * record with a TTL, and a forgotten invite cannot be accepted a year on.
     */
    this.invitesTable = new dynamodb.Table(this, 'InvitesTable', {
      partitionKey: { name: 'email', type: dynamodb.AttributeType.STRING },
      ...durable,
      timeToLiveAttribute: 'expires_at',
    });

    this.jobsTable = new dynamodb.Table(this, 'JobsTable', {
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      ...durable,
      timeToLiveAttribute: 'expires_at',
    });
    this.jobsTable.addGlobalSecondaryIndex({
      indexName: Storage.JOBS_BY_MEDIA,
      partitionKey: { name: 'media_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'started_at', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    /*
     * Open WebSocket connections. TTL sweeps any that never sent $disconnect.
     *
     * `user_id` is written by $connect from the authorizer's verified claim, and
     * the index is what lets the broadcaster reach one person's sockets instead
     * of scanning every socket in the system.
     */
    this.connectionsTable = new dynamodb.Table(this, 'ConnectionsTable', {
      partitionKey: { name: 'connection_id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'expires_at',
    });
    this.connectionsTable.addGlobalSecondaryIndex({
      indexName: Storage.CONNECTIONS_BY_USER,
      partitionKey: { name: 'user_id', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.KEYS_ONLY,
    });
  }
}
