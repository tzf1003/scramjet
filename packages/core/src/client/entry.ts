import { CapturedGlobal } from "@/shared/snapshot";
// entrypoint for scramjet.client.js

import { ScramjetContext, ScramjetInterface } from "@/shared/index";
import { SCRAMJETCLIENT } from "@/symbols";
import { ScramjetClient } from "@client/index";
import { ScramjetConfig } from "@/types";

export const iswindow =
	CapturedGlobal.window === CapturedGlobal && "document" in CapturedGlobal;
export const isworker = "WorkerGlobalScope" in CapturedGlobal;
export const issw = "ServiceWorkerGlobalScope" in CapturedGlobal;
export const isdedicated = "DedicatedWorkerGlobalScope" in CapturedGlobal;
export const isshared = "SharedWorkerGlobalScope" in CapturedGlobal;
