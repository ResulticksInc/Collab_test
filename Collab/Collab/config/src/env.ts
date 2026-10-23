// The single boundary where process.env is read. Every other module consumes
// the assembled config object from `@colab/config` — never process.env directly.
import path from "path";
import dotenv from "dotenv";
try {
  dotenv.config({ path: path.resolve(__dirname, "../../.env") });
} catch (_) {}

const str = (k, d) =>
  process.env[k] !== undefined && process.env[k] !== "" ? process.env[k] : d;
const num = (k, d) => {
  const v = process.env[k];
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
};
const bool = (k, d) => {
  const v = process.env[k];
  if (v === undefined) return d;
  return ["1", "true", "yes", "on"].includes(String(v).toLowerCase());
};
const list = (k, d) => {
  const v = process.env[k];
  return v
    ? v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : d;
};

export { str, num, bool, list };
