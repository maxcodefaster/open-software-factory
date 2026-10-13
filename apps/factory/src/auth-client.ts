import { createAuthClient } from "better-auth/client";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { ssoClient } from "@better-auth/sso/client";

export const factoryIdentityClient = createAuthClient({
  plugins: [oauthProviderClient(), ssoClient()],
});
