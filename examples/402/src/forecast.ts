// The example's data: what the paywall sells, and the schema the buyer checks it against.
import type { DataSchema } from "./receipts.js";

/** The body of a paid call. TEST DATA: nothing here is a real forecast. */
export function forecastData(call: number) {
  return {
    call,
    note: "TEST DATA from the Probarion 402 example",
    city: "Hanoi",
    forecast_c: [31, 30, 29],
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A city and 1 to 14 daily temperatures in degrees C, between -90 and 60. */
export const forecastSchema: DataSchema = (data) => {
  if (!isRecord(data)) return ["the data is not an object"];
  const problems: string[] = [];
  if (typeof data.city !== "string" || data.city.length === 0 || data.city.length > 100) {
    problems.push("city is not a name of 1 to 100 characters");
  }
  const days = data.forecast_c;
  if (!Array.isArray(days) || days.length < 1 || days.length > 14) {
    problems.push("forecast_c is not a list of 1 to 14 temperatures");
  } else if (
    !days.every((t) => typeof t === "number" && Number.isFinite(t) && t >= -90 && t <= 60)
  ) {
    problems.push("forecast_c holds something that is not a temperature between -90 and 60");
  }
  return problems;
};
