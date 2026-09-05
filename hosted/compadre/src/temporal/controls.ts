import { defineUpdate } from "@temporalio/workflow";
import type { NativeT3SteeringInput } from "../t3/run-control.js";

export const steerNativeT3Run = defineUpdate<
  boolean,
  [NativeT3SteeringInput]
>("steerNativeT3Run");
