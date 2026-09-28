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
 * Self-signup is disabled: the single owner account is created out of band with
 * `aws cognito-idp admin-create-user`, so nobody else can ever reach the data.
 * Sign-in goes through the Hosted UI (authorization code + PKCE) so this app
 * never handles a password itself.
 */
export class Auth extends Construct {
  readonly userPool: cognito.UserPool;
  readonly userPoolClient: cognito.UserPoolClient;
  readonly domain: cognito.UserPoolDomain;

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

    this.domain = this.userPool.addDomain('HostedUi', {
      cognitoDomain: { domainPrefix: `reel-lens-${Stack.of(this).account}` },
    });
  }
}
