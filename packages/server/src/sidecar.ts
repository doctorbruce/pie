import * as bedrockProvider from "@earendil-works/pi-ai/api/bedrock-converse-stream";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { setBedrockProviderModule } from "@earendil-works/pi-ai/compat";
import "./cli.ts";

setBedrockProviderModule(bedrockProvider);
registerBunOAuthFlows();
