// The runners' scaler (AWS Lambda, Node 22; the AWS SDK comes with the runtime). It runs on
// GitHub's workflow_job webhook (a function URL) and every minute (EventBridge), and each time
// reconciles the queue with the runners (scaler.mjs). Its reserved concurrency is 1, so two
// passes never start runners for the same job; a webhook that arrives meanwhile is picked up
// by the next pass.
import {
  DescribeInstancesCommand,
  EC2Client,
  RunInstancesCommand,
  TerminateInstancesCommand,
} from "@aws-sdk/client-ec2";
import { DeleteParameterCommand, GetParametersCommand, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { githubClient, verifySignature } from "./github.mjs";
import { launchWithFallback, reconcile } from "./scaler.mjs";

const env = process.env;
const list = (s) =>
  (s ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
const config = {
  repository: env.REPOSITORY,
  labels: list(env.RUNNER_LABELS),
  namePrefix: `${env.DEPLOYMENT}-`,
  maxRunners: Number(env.MAX_RUNNERS),
  maxLifetimeMinutes: Number(env.MAX_LIFETIME_MINUTES),
  idleMinutes: Number(env.IDLE_MINUTES),
  bootMinutes: Number(env.BOOT_MINUTES),
};
const launchConfig = {
  instanceTypes: list(env.INSTANCE_TYPES),
  subnets: list(env.SUBNET_IDS),
  onDemandFallback: env.ON_DEMAND_FALLBACK === "true",
};
const TAG = "hbe:grader-runner";

const ec2Client = new EC2Client({});
const ssm = new SSMClient({});
const log = (message, fields = {}) => console.log(JSON.stringify({ message, ...fields }));

let settings = null;
async function loadSettings() {
  if (settings) return settings;
  const names = ["github-app-id", "github-app-private-key", "webhook-secret"].map((n) => `${env.SSM_PREFIX}/${n}`);
  const res = await ssm.send(new GetParametersCommand({ Names: names, WithDecryption: true }));
  const value = (n) => {
    const p = res.Parameters?.find((x) => x.Name === `${env.SSM_PREFIX}/${n}`);
    if (!p?.Value) throw new Error(`Set the SSM parameter ${env.SSM_PREFIX}/${n} (README.md)`);
    return p.Value;
  };
  settings = {
    appId: value("github-app-id"),
    privateKey: value("github-app-private-key"),
    secret: value("webhook-secret"),
  };
  return settings;
}

const ec2 = {
  async instances() {
    const out = [];
    let NextToken;
    do {
      const page = await ec2Client.send(
        new DescribeInstancesCommand({
          Filters: [
            { Name: `tag:${TAG}`, Values: [env.DEPLOYMENT] },
            { Name: "instance-state-name", Values: ["pending", "running"] },
          ],
          NextToken,
        }),
      );
      for (const r of page.Reservations ?? []) {
        for (const i of r.Instances ?? []) {
          out.push({
            id: i.InstanceId,
            runnerName: i.Tags?.find((t) => t.Key === "RunnerName")?.Value ?? "",
            launchedAt: new Date(i.LaunchTime),
          });
        }
      }
      NextToken = page.NextToken;
    } while (NextToken);
    return out;
  },
  launch(runnerName) {
    return launchWithFallback(
      async ({ instanceType, spot, subnet }) => {
        const res = await ec2Client.send(
          new RunInstancesCommand({
            LaunchTemplate: { LaunchTemplateId: env.LAUNCH_TEMPLATE_ID, Version: "$Latest" },
            InstanceType: instanceType,
            SubnetId: subnet,
            MinCount: 1,
            MaxCount: 1,
            ...(spot
              ? {
                  InstanceMarketOptions: {
                    MarketType: "spot",
                    SpotOptions: { SpotInstanceType: "one-time", InstanceInterruptionBehavior: "terminate" },
                  },
                }
              : {}),
            TagSpecifications: ["instance", "volume"].map((ResourceType) => ({
              ResourceType,
              Tags: [
                { Key: "Name", Value: runnerName },
                { Key: TAG, Value: env.DEPLOYMENT },
                { Key: "RunnerName", Value: runnerName },
              ],
            })),
          }),
        );
        return res.Instances[0].InstanceId;
      },
      launchConfig,
      runnerName,
    );
  },
  async terminate(ids) {
    if (ids.length > 0) await ec2Client.send(new TerminateInstancesCommand({ InstanceIds: ids }));
  },
};

const secrets = {
  async put(name, value) {
    await ssm.send(
      new PutParameterCommand({
        Name: `${env.SSM_PREFIX}/jit/${name}`,
        Value: value,
        Type: "SecureString",
        Overwrite: true,
      }),
    );
  },
  async remove(name) {
    await ssm.send(new DeleteParameterCommand({ Name: `${env.SSM_PREFIX}/jit/${name}` })).catch((err) => {
      if (err?.name !== "ParameterNotFound") throw err;
    });
  },
};

let github = null;
async function pass() {
  const s = await loadSettings();
  github ??= githubClient({ appId: s.appId, privateKey: s.privateKey, repository: config.repository });
  const result = await reconcile({ github, ec2, secrets, log }, config);
  log("reconciled", result);
  return result;
}

export async function handler(event) {
  // EventBridge schedule: no HTTP request.
  if (!event?.requestContext?.http) return pass();

  const body = event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString("utf8") : (event.body ?? "");
  const headers = Object.fromEntries(Object.entries(event.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const { secret } = await loadSettings();
  if (!verifySignature(secret, body, headers["x-hub-signature-256"])) {
    return { statusCode: 401, body: "bad signature" };
  }
  if (headers["x-github-event"] !== "workflow_job") return { statusCode: 200, body: "ignored" };
  const payload = JSON.parse(body);
  if (payload.repository?.full_name?.toLowerCase() !== config.repository.toLowerCase()) {
    return { statusCode: 200, body: "not the grader repository" };
  }
  if (payload.action !== "queued") return { statusCode: 200, body: "nothing to do" };
  const result = await pass();
  return { statusCode: 202, body: JSON.stringify(result) };
}
