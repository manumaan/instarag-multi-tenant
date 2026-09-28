import { Construct } from 'constructs';
import { CfnOutput, DefaultStackSynthesizer, Lazy, Stack } from 'aws-cdk-lib';
import * as oss from 'aws-cdk-lib/aws-opensearchserverless';
import * as iam from 'aws-cdk-lib/aws-iam';

export interface SearchProps {
  /** Ceiling on OCUs, so a runaway query cannot run up the bill. */
  readonly maxOcu: number;
}

/**
 * Vector index for Ask and Lens: OpenSearch Serverless, VECTORSEARCH.
 *
 * Deliberately a NEXTGEN collection group. A classic collection bills a 2-OCU
 * floor (~$350/month) whether or not it is used, which would dwarf every other
 * cost in this app; NEXTGEN has no OCU minimum and scales indexing and search
 * to zero after ten minutes of inactivity.
 */
export class Search extends Construct {
  readonly collection: oss.CfnCollection;
  readonly index: oss.CfnIndex;
  /** 1024 matches Titan Multimodal Embeddings' default output length. */
  static readonly VECTOR_DIMENSION = 1024;
  static readonly INDEX_NAME = 'frames';

  // Collected as callers grant access; the policy document is rendered at
  // synth time so the handlers can depend on the collection endpoint without
  // the collection depending on their roles.
  private readonly writerRoleArns: string[] = [];
  private readonly readerRoleArns: string[] = [];

  constructor(scope: Construct, id: string, props: SearchProps) {
    super(scope, id);

    const stack = Stack.of(this);
    const name = `reel-lens-${stack.account}`.slice(0, 32);

    /**
     * AWS::OpenSearchServerless::Index is created by CloudFormation itself, so
     * the deploy role needs CreateIndex in the data access policy — without it
     * the resource fails with a bare "Access denied for operation CreateIndex".
     * Derived from the bootstrap pattern rather than hardcoded.
     */
    const qualifier =
      stack.node.tryGetContext('@aws-cdk/core:bootstrapQualifier') ?? DefaultStackSynthesizer.DEFAULT_QUALIFIER;
    this.writerRoleArns.push(
      `arn:${stack.partition}:iam::${stack.account}:role/cdk-${qualifier}-cfn-exec-role-${stack.account}-${stack.region}`,
    );

    const group = new oss.CfnCollectionGroup(this, 'CollectionGroup', {
      name: `${name}-grp`.slice(0, 32),
      generation: 'NEXTGEN',
      // NEXTGEN rejects DISABLED. That is fine: the saving comes from scaling
      // to zero after ten minutes idle, not from dropping the standby.
      standbyReplicas: 'ENABLED',
      capacityLimits: {
        // NEXTGEN scales to zero; these are only ceilings.
        maxIndexingCapacityInOcu: props.maxOcu,
        maxSearchCapacityInOcu: props.maxOcu,
      },
      description: 'Reel Lens vector search (scales to zero)',
    });

    const encryption = new oss.CfnSecurityPolicy(this, 'EncryptionPolicy', {
      name: `${name}-enc`.slice(0, 32),
      type: 'encryption',
      policy: JSON.stringify({
        Rules: [{ ResourceType: 'collection', Resource: [`collection/${name}`] }],
        AWSOwnedKey: true,
      }),
    });

    // Reachable from the internet but useless without IAM: access is granted
    // solely by the data access policy below, to two Lambda roles.
    const network = new oss.CfnSecurityPolicy(this, 'NetworkPolicy', {
      name: `${name}-net`.slice(0, 32),
      type: 'network',
      policy: JSON.stringify([
        {
          Rules: [{ ResourceType: 'collection', Resource: [`collection/${name}`] }],
          AllowFromPublic: true,
        },
      ]),
    });

    this.collection = new oss.CfnCollection(this, 'Collection', {
      name,
      type: 'VECTORSEARCH',
      // Redundancy is governed by the collection group.
      collectionGroupName: group.name,
      description: 'Reel Lens keyframes',
    });
    this.collection.addDependency(encryption);
    this.collection.addDependency(network);
    this.collection.addDependency(group);

    const access = new oss.CfnAccessPolicy(this, 'AccessPolicy', {
      name: `${name}-data`.slice(0, 32),
      type: 'data',
      policy: Lazy.string({
        produce: () =>
          JSON.stringify(
            [
              this.writerRoleArns.length > 0 && {
                Rules: [
                  {
                    ResourceType: 'index',
                    Resource: [`index/${name}/*`],
                    Permission: [
                      'aoss:CreateIndex',
                      'aoss:DescribeIndex',
                      'aoss:ReadDocument',
                      'aoss:WriteDocument',
                      'aoss:UpdateIndex',
                    ],
                  },
                ],
                Principal: this.writerRoleArns,
              },
              this.readerRoleArns.length > 0 && {
                Rules: [
                  {
                    ResourceType: 'index',
                    Resource: [`index/${name}/*`],
                    Permission: ['aoss:DescribeIndex', 'aoss:ReadDocument'],
                  },
                ],
                Principal: this.readerRoleArns,
              },
            ].filter(Boolean),
          ),
      }),
    });
    access.addDependency(this.collection);

    // The index is declared here rather than created at runtime, so its
    // mapping is reviewable in the diff like everything else.
    this.index = new oss.CfnIndex(this, 'FramesIndex', {
      collectionEndpoint: this.collection.attrCollectionEndpoint,
      indexName: Search.INDEX_NAME,
      settings: { index: { knn: true } },
      mappings: {
        properties: {
          embedding: {
            type: 'knn_vector',
            dimension: Search.VECTOR_DIMENSION,
            // No `engine`: NEXTGEN collections reject that parameter.
            method: { name: 'hnsw', spaceType: 'cosinesimil' },
          },
          media_id: { type: 'keyword' },
          // CfnIndex allows only text/knn_vector/keyword/integer; ms offsets
          // into a reel fit an integer with room to spare.
          ts_ms: { type: 'integer' },
          description: { type: 'text' },
          // Signage and street names live here, so Ask can match an exact
          // phrase as well as a nearby vector.
          ocr_text: { type: 'text' },
          caption: { type: 'text' },
          places: { type: 'text' },
          taken_at: { type: 'keyword' },
        },
      },
    });
    this.index.addDependency(access);

    new CfnOutput(this, 'CollectionEndpoint', { value: this.collection.attrCollectionEndpoint });
  }

  get endpoint(): string {
    return this.collection.attrCollectionEndpoint;
  }

  /**
   * Access needs both halves: the IAM action that gates data-plane calls, and
   * the collection's own data access policy naming the role.
   */
  private grant(fn: iam.IGrantable & { readonly role?: iam.IRole }, arns: string[]) {
    fn.grantPrincipal.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['aoss:APIAccessAll'],
        resources: [this.collection.attrArn],
      }),
    );
    const roleArn = fn.role?.roleArn;
    if (roleArn) arns.push(roleArn);
  }

  grantWrite(fn: iam.IGrantable & { readonly role?: iam.IRole }) {
    this.grant(fn, this.writerRoleArns);
  }

  grantRead(fn: iam.IGrantable & { readonly role?: iam.IRole }) {
    this.grant(fn, this.readerRoleArns);
  }
}
