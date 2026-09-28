import type { APIGatewayRequestAuthorizerEvent, APIGatewayAuthorizerResult } from 'aws-lambda';
import { CognitoJwtVerifier } from 'aws-jwt-verify';

/**
 * WebSocket APIs have no built-in JWT authorizer, so the same Cognito id token
 * the HTTP API takes in a header arrives here as a query parameter and is
 * verified against the pool's public keys.
 */
const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.USER_POOL_ID!,
  tokenUse: 'id',
  clientId: process.env.USER_POOL_CLIENT_ID!,
});

const policy = (effect: 'Allow' | 'Deny', principalId: string, resource: string): APIGatewayAuthorizerResult => ({
  principalId,
  policyDocument: {
    Version: '2012-10-17',
    Statement: [{ Action: 'execute-api:Invoke', Effect: effect, Resource: resource }],
  },
});

export const main = async (event: APIGatewayRequestAuthorizerEvent): Promise<APIGatewayAuthorizerResult> => {
  const token = event.queryStringParameters?.token;
  if (!token) return policy('Deny', 'anonymous', event.methodArn);
  try {
    const claims = await verifier.verify(token);
    return policy('Allow', claims.sub, event.methodArn);
  } catch (err) {
    console.warn('rejected websocket token', { err: err instanceof Error ? err.message : err });
    return policy('Deny', 'anonymous', event.methodArn);
  }
};
