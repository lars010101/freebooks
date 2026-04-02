const { BigQuery } = require('@google-cloud/bigquery');
const bq = new BigQuery();

async function run() {
  const query = `
    CREATE TABLE IF NOT EXISTS finance.periods (
      company_id STRING NOT NULL,
      period_name STRING NOT NULL,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      locked BOOL DEFAULT FALSE,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(),
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP()
    );
  `;
  try {
    const [job] = await bq.createQueryJob({ query });
    await job.getQueryResults();
    console.log("Table created successfully.");
  } catch (e) {
    console.error("Error:", e);
  }
}
run();
