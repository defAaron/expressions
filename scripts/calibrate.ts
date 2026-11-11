const apiKey = process.env.MAGIC_HOUR_API_KEY;
const portraitPath = process.argv[2];

if (!apiKey) {
  console.error("MAGIC_HOUR_API_KEY is missing.");
  process.exit(1);
}

if (!portraitPath) {
  console.error("Portrait path (process.argv[2]) is missing.");
  process.exit(1);
}

console.error("Calibration spend is not confirmed.");
process.exit(1);
