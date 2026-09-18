const { chromium } = require('playwright');
const fs = require('fs');


// ========================================================
// 設定
// ========================================================

const CONFIG = {

  // ★監視したい日付
  TARGET_DATES: [
    '2026-09-22',

    // 複数日なら追加
    // '2026-09-23',
    // '2026-09-25',
  ],

  CALENDAR_URL:
    'https://museum-tickets.nintendo.com/calendar',

  // 現在確認できている「空きなし」のsale_status
  KNOWN_SOLD_OUT_STATUS: 2,

  // 営業日のopen_status
  OPEN_STATUS: 1,

  STATE_FILE:
    'state.json'
};


// ========================================================
// メイン
// ========================================================

async function main() {

  console.log(
    'Nintendo Museum monitor start'
  );


  const webhookUrl =
    process.env.DISCORD_WEBHOOK_URL;


  if (!webhookUrl) {

    console.warn(
      'DISCORD_WEBHOOK_URL is not configured'
    );
  }


  const state =
    loadState();


  const browser =
    await chromium.launch({
      headless: true
    });


  try {

    const context =
      await browser.newContext({
        locale: 'ja-JP'
      });


    const page =
      await context.newPage();


    // Nintendo Museumを通常のブラウザとして開く
    await page.goto(
      CONFIG.CALENDAR_URL,
      {
        waitUntil:
          'domcontentloaded',

        timeout:
          60000
      }
    );


    // Cookie / JS初期化待ち
    await page.waitForTimeout(
      5000
    );


    // 必要な年月だけ取得
    const months =
      getTargetMonths();


    const allCalendar = {};


    for (
      const { year, month }
      of months
    ) {

      console.log(
        `Fetch calendar: ${year}/${month}`
      );


      const calendar =
        await fetchCalendar(
          page,
          year,
          month
        );


      Object.assign(
        allCalendar,
        calendar
      );
    }


    // 各監視日を確認
    for (
      const targetDate
      of CONFIG.TARGET_DATES
    ) {

      const day =
        allCalendar[targetDate];


      if (!day) {

        console.warn(
          `${targetDate}: no calendar data`
        );

        continue;
      }


      console.log(
        `${targetDate}: ` +
        `open_status=${day.open_status}, ` +
        `sale_status=${day.sale_status}`
      );


      const currentState = {

        open_status:
          day.open_status,

        sale_status:
          day.sale_status
      };


      const previous =
        state[targetDate];


      // --------------------------------------
      // 非営業日は通知しない
      // --------------------------------------

      if (
        day.open_status !==
        CONFIG.OPEN_STATUS
      ) {

        console.log(
          `${targetDate}: not an open day`
        );


        state[targetDate] =
          currentState;


        continue;
      }


      // --------------------------------------
      // 現状確認済み：
      //
      // sale_status = 2
      // → 空きなし
      //
      // 2以外
      // → 空き発生の可能性
      // --------------------------------------

      const potentialAvailability =
        day.sale_status !==
        CONFIG.KNOWN_SOLD_OUT_STATUS;


      const previousSaleStatus =
        previous
          ? previous.sale_status
          : null;


      const statusChanged =
        previousSaleStatus !==
        day.sale_status;


      // --------------------------------------
      // 通知
      //
      // ・営業日
      // ・sale_status != 2
      // ・前回から状態が変化
      // --------------------------------------

      if (
        potentialAvailability &&
        statusChanged
      ) {

        console.log(
          `*** POSSIBLE AVAILABILITY: ${targetDate} ***`
        );


        const oldStatus =
          previousSaleStatus === null
            ? '初回取得'
            : previousSaleStatus;


        const message =
`🎫 **ニンテンドーミュージアム 空き発生候補**

🚨 **販売状態が変化しました**

📅 **${targetDate}**

sale_status:
\`${oldStatus} → ${day.sale_status}\`

open_status:
\`${day.open_status}\`

今すぐ公式サイトを確認してください。

${CONFIG.CALENDAR_URL}`;


        if (webhookUrl) {

          await sendDiscord(
            webhookUrl,
            message
          );

        } else {

          console.warn(
            'Webhook未設定のためDiscord通知なし'
          );
        }
      }


      // 現在状態を保存
      state[targetDate] =
        currentState;
    }


    saveState(
      state
    );


  } finally {

    await browser.close();
  }


  console.log(
    'Nintendo Museum monitor finished'
  );
}


// ========================================================
// Nintendo API取得
// ========================================================

async function fetchCalendar(
  page,
  year,
  month
) {

  const result =
    await page.evaluate(
      async ({ year, month }) => {

        function getCookie(name) {

          const cookies =
            document.cookie.split(';');


          for (
            const cookie
            of cookies
          ) {

            const [
              key,
              ...rest
            ] =
              cookie
                .trim()
                .split('=');


            if (key === name) {

              return rest.join('=');
            }
          }


          return null;
        }


        const xsrf =
          getCookie(
            'XSRF-TOKEN'
          );


        const headers = {

          'Accept':
            'application/json, text/plain, */*',

          'X-Requested-With':
            'XMLHttpRequest'
        };


        if (xsrf) {

          headers[
            'X-XSRF-TOKEN'
          ] =
            decodeURIComponent(
              xsrf
            );
        }


        const url =
          `/api/calendar` +
          `?target_year=${year}` +
          `&target_month=${month}`;


        const response =
          await fetch(
            url,
            {
              method:
                'GET',

              headers,

              credentials:
                'same-origin'
            }
          );


        const text =
          await response.text();


        if (!response.ok) {

          throw new Error(
            `Calendar API HTTP ` +
            `${response.status}: ` +
            text.slice(0, 200)
          );
        }


        try {

          return JSON.parse(
            text
          );

        } catch {

          throw new Error(
            'Calendar API returned non-JSON: ' +
            text.slice(0, 200)
          );
        }

      },
      {
        year,
        month
      }
    );


  if (
    !result ||
    !result.data ||
    !result.data.calendar
  ) {

    throw new Error(
      'Unexpected Calendar API response'
    );
  }


  return result.data.calendar;
}


// ========================================================
// 必要年月取得
// ========================================================

function getTargetMonths() {

  const months =
    new Map();


  for (
    const date
    of CONFIG.TARGET_DATES
  ) {

    const match =
      date.match(
        /^(\d{4})-(\d{2})-(\d{2})$/
      );


    if (!match) {

      throw new Error(
        `Invalid date: ${date}`
      );
    }


    const year =
      Number(match[1]);


    const month =
      Number(match[2]);


    const key =
      `${year}-${month}`;


    months.set(
      key,
      {
        year,
        month
      }
    );
  }


  return [
    ...months.values()
  ];
}


// ========================================================
// Discord
// ========================================================

async function sendDiscord(
  webhookUrl,
  message
) {

  const response =
    await fetch(
      webhookUrl,
      {
        method:
          'POST',

        headers: {
          'Content-Type':
            'application/json'
        },

        body:
          JSON.stringify({
            content:
              message
          })
      }
    );


  if (!response.ok) {

    const text =
      await response.text();


    throw new Error(
      `Discord HTTP ` +
      `${response.status}: ` +
      text.slice(0, 200)
    );
  }


  console.log(
    'Discord notification sent'
  );
}


// ========================================================
// 状態保存
// ========================================================

function loadState() {

  if (
    !fs.existsSync(
      CONFIG.STATE_FILE
    )
  ) {

    return {};
  }


  try {

    const text =
      fs.readFileSync(
        CONFIG.STATE_FILE,
        'utf8'
      );


    return JSON.parse(
      text
    );

  } catch (error) {

    console.warn(
      'state.json could not be read. Resetting state.'
    );


    return {};
  }
}


function saveState(state) {

  fs.writeFileSync(
    CONFIG.STATE_FILE,

    JSON.stringify(
      state,
      null,
      2
    ) + '\n',

    'utf8'
  );
}


// ========================================================
// 実行
// ========================================================

main()
  .catch(
    error => {

      console.error(
        error
      );

      process.exit(1);
    }
  );
