import { Construct } from 'constructs';
import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';

export interface AuthProps {
  /** Hosted UI redirect targets, e.g. http://localhost:3000/ */
  readonly webOrigins: string[];
}

/**
 * Cognito user pool for app sign-in.
 *
 * Self-signup is disabled: an account exists only because an admin invited it,
 * which makes the invite flow the entire front door. The first admin account is
 * created out of band with `aws cognito-idp admin-create-user` and added to the
 * admin group; everyone after that arrives through the admin screen.
 * Sign-in goes through the Hosted UI (authorization code + PKCE) so this app
 * never handles a password itself.
 */
export class Auth extends Construct {
  readonly userPool: cognito.UserPool;
  readonly userPoolClient: cognito.UserPoolClient;
  readonly domain: cognito.UserPoolDomain;
  /** Group name the API checks for on the admin routes. */
  static readonly ADMIN_GROUP = 'admin';

  constructor(scope: Construct, id: string, props: AuthProps) {
    super(scope, id);

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      signInCaseSensitive: false,
      standardAttributes: { email: { required: true, mutable: false } },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { sms: false, otp: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    /*
     * Admin is a group, so the check is on a token claim rather than on an
     * address written into the source. The first member is added out of band,
     * like the owner account itself:
     *   aws cognito-idp admin-add-user-to-group --user-pool-id <id> \
     *     --username <email> --group-name admin
     */
    new cognito.CfnUserPoolGroup(this, 'AdminGroup', {
      userPoolId: this.userPool.userPoolId,
      groupName: Auth.ADMIN_GROUP,
      description: 'May invite others and see what each account has cost.',
    });

    const callbackUrls = props.webOrigins.map((o) => `${o}/auth/callback`);

    this.userPoolClient = this.userPool.addClient('WebClient', {
      generateSecret: false, // public SPA client; PKCE instead of a secret
      authFlows: { userSrp: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls,
        logoutUrls: props.webOrigins,
      },
      preventUserExistenceErrors: true,
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
    });

    /*
     * A Cognito domain prefix is unique across the whole region, so a constant
     * is a collision as soon as this account runs a second stack — and it runs
     * the single-user MVP. Deriving it from the stack name keeps two
     * deployments apart without anyone having to remember to.
     */
    const stack = Stack.of(this);
    this.domain = this.userPool.addDomain('HostedUi', {
      cognitoDomain: {
        domainPrefix: `${stack.stackName.toLowerCase().replace(/[^a-z0-9]/g, '')}-${stack.account}`,
      },
    });
  }
}
