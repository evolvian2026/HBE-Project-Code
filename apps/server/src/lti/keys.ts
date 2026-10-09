import { generateToolKey, loadToolKeys, type ToolKeys } from "@hbe/lms";
import type { Settings } from "@hbe/settings";

const pemFrom = (value: string) => (value.includes("BEGIN") ? value : Buffer.from(value, "base64").toString("utf8"));

let cached: Promise<ToolKeys | null> | null = null;

/**
 * The LTI tool's signing keys (LTI_PRIVATE_KEY_BASE64, plus the previous key during a
 * rollover). Locally, without a key, a temporary one is generated at startup; elsewhere LTI is
 * off until a key is configured.
 */
export function toolKeys(settings: Settings): Promise<ToolKeys | null> {
  cached ??= (async () => {
    const env = settings.env;
    if (env.LTI_PRIVATE_KEY_BASE64) {
      return loadToolKeys(
        { pem: pemFrom(env.LTI_PRIVATE_KEY_BASE64), kid: env.LTI_KEY_ID ?? "lti-1" },
        env.LTI_PREVIOUS_PRIVATE_KEY_BASE64
          ? { pem: pemFrom(env.LTI_PREVIOUS_PRIVATE_KEY_BASE64), kid: env.LTI_PREVIOUS_KEY_ID ?? "lti-0" }
          : undefined,
      );
    }
    if (env.HBE_ENV === "local") return { current: await generateToolKey("local-dev") };
    return null;
  })();
  return cached;
}
