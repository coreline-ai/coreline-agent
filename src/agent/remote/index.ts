/**
 * Remote agent — barrel export.
 */

export type {
  RemoteAgentEndpoint,
  RemoteBatchResult,
  RemoteSchedulerConfig,
  RemoteTaskRequest,
  RemoteTaskResult,
  RemoteTaskStatus,
  RetryPolicy,
} from "./types.js";

export {
  REMOTE_DEFAULT_MAX_CONCURRENT,
  REMOTE_DEFAULT_RETRY,
  REMOTE_DEFAULT_TIMEOUT_MS,
} from "./types.js";

export { sendRemoteTask, checkEndpointHealth } from "./client.js";
export type { SendTaskOptions } from "./client.js";
export { RemoteScheduler } from "./scheduler.js";
export { RemoteSubAgentRuntime } from "./runtime.js";
