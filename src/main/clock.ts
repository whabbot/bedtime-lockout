import type { ClockPort } from "./ports";

export class SystemClock implements ClockPort {
  now(): Date {
    return new Date();
  }
}
