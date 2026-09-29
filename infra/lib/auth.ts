import { Construct } from 'constructs';
import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

export interface AuthProps {
  /** Hosted UI redirect targets, e.g. http://localhost:3000/ */
  readonly webOrigins: string[];
  /** The site's own URL, linked from the invite email. */
  readonly siteUrl: string;
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
  /**
   * The mobile app's URL scheme (mobile/app.json). The app signs in through the
   * same client as the web, so the API's authorizer accepts its tokens as they
   * are; Cognito only needs to be allowed to redirect back into it. The same
   * PKCE flow protects a custom scheme: an app that registered it too would
   * receive a code it cannot redeem without the verifier.
   */
  static readonly MOBILE_SCHEME = 'reellens';

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
     * The invite email. The pool's own template can substitute only the
     * username and the temporary password, so it cannot greet anyone by name or
     * link to the site; a CustomMessage trigger can. It needs no permissions:
     * Cognito passes it everything and fills the password in afterwards.
     */
    const inviteMessage = new NodejsFunction(this, 'InviteMessage', {
      entry: path.join(__dirname, '..', 'lambda', 'auth', 'invite-message.ts'),
      handler: 'main',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 128,
      timeout: Duration.seconds(5),
      environment: { SITE_URL: props.siteUrl },
      logGroup: new logs.LogGroup(this, 'InviteMessageLogs', { retention: logs.RetentionDays.TWO_WEEKS }),
      bundling: { minify: true, format: OutputFormat.CJS, target: 'node22' },
    });
    this.userPool.addTrigger(cognito.UserPoolOperation.CUSTOM_MESSAGE, inviteMessage);

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

    const callbackUrls = [
      ...props.webOrigins.map((o) => `${o}/auth/callback`),
      `${Auth.MOBILE_SCHEME}://auth/callback`,
    ];
    const logoutUrls = [...props.webOrigins, `${Auth.MOBILE_SCHEME}://signed-out`];

    this.userPoolClient = this.userPool.addClient('WebClient', {
      generateSecret: false, // public SPA client; PKCE instead of a secret
      authFlows: { userSrp: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls,
        logoutUrls,
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
      // Managed login, not the classic hosted UI: it is the version that takes
      // real branding, so the sign-in sheet looks like part of the app rather
      // than a generic AWS form. Needs the Essentials feature plan, which this
      // pool is on. Switching signs everyone out of the Cognito page once
      // (the app's own tokens are unaffected).
      managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });

    /*
     * The sign-in page's look, in the app's own palette (mobile/src/components/ui.tsx):
     * its background, blue buttons and links, rounded form, and a Reel Lens
     * logo, following the device's light or dark mode as the app does.
     *
     * Managed login renders nothing for an app client without a style, and a
     * client created through CloudFormation gets none by default. The settings
     * file started as Cognito's own default document — read back with
     * describe-managed-login-branding-by-client, as AWS's docs advise, since
     * the schema is large — with only the look changed, so every key in it is
     * one Cognito recognises.
     */
    const brandingDir = path.join(__dirname, 'branding');
    const logo = (mode: 'LIGHT' | 'DARK') => ({
      category: 'FORM_LOGO',
      colorMode: mode,
      extension: 'SVG',
      bytes: readFileSync(path.join(brandingDir, `logo-${mode.toLowerCase()}.svg`)).toString('base64'),
    });
    new cognito.CfnManagedLoginBranding(this, 'LoginBranding', {
      userPoolId: this.userPool.userPoolId,
      clientId: this.userPoolClient.userPoolClientId,
      useCognitoProvidedValues: false,
      settings: JSON.parse(readFileSync(path.join(brandingDir, 'managed-login.json'), 'utf8')),
      assets: [logo('LIGHT'), logo('DARK')],
    });
  }
}
