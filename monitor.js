const { chromium } = require('playwright');

const TARGET_DATE = '2026-09-22';

const CALENDAR_URL =
  'https://museum-tickets.nintendo.com/calendar';

async function main() {
  console.log('Nintendo Museum monitor start');

  const browser = await chromium.launch({
    headless: true
  });

  const context = await browser.newContext({
    locale: 'ja-JP'
  });

  const page = await context.newPage();

  await page.goto(CALENDAR_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  await page.waitForTimeout(5000);

  const match = TARGET_DATE.match(
    /^(\d{4})-(\d{2})-(\d{2})$/
  );

  if (!match) {
    throw new Error('TARGET_DATE format error');
  }

  const year = Number(match[1]);
  const month = Number(match[2]);

  const result = await page.evaluate(
    async ({ year, month }) => {
      const getCookie = (name) => {
        const cookies = document.cookie.split(';');

        for (const cookie of cookies) {
          const [key, ...rest] =
            cookie.trim().split('=');

          if (key === name) {
            return rest.join('=');
          }
        }

        return null;
      };

      const xsrf =
        getCookie('XSRF-TOKEN');

      const headers = {
        'Accept':
          'application/json, text/plain, */*',
        'X-Requested-With':
          'XMLHttpRequest'
      };

      if (xsrf) {
        headers['X-XSRF-TOKEN'] =
          decodeURIComponent(xsrf);
      }

      const response = await fetch(
        `/api/calendar?target_year=${year}&target_month=${month}`,
        {
          method: 'GET',
          headers,
          credentials: 'same-origin'
        }
      );

      const text = await response.text();

      if (!response.ok) {
        throw new Error(
          `HTTP ${response.status}: ${text.slice(0, 200)}`
        );
      }

      return JSON.parse(text);
    },
    { year, month }
  );

  const day =
    result?.data?.calendar?.[TARGET_DATE];

  if (!day) {
    throw new Error(
      `No data for ${TARGET_DATE}`
    );
  }

  console.log(
    `${TARGET_DATE}: ` +
    `open_status=${day.open_status}, ` +
    `sale_status=${day.sale_status}`
  );

  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
