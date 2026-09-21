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
    'state.json',

  // 自動停止対象のWorkflowファイル名
  WORKFLOW_FILE:
    'monitor.yml',

  // 日本時間
  TIMEZONE:
    'Asia/Tokyo'
};


// ========================================================
// メイン
// ========================================================

async function main() {

  console.log(
    'Nintendo Museum monitor start'
  );


  // --------------------------------------------------------
  // 監視期間終了チェック
  //
  // 最後のTARGET_DATEの翌日になったら
  // Workflowを自動停止する
  // --------------------------------------------------------

  if (isMonitoringPeriodOver()) {

    const latestDate =
      getLatestTargetDate();

    console.log(
      `Monitoring period ended. ` +
      `Latest target date: ${latestDate}`
    );


    await disableWorkflow();


    console.log(
      'Nintendo Museum monitor stopped automatically'
    );

    return;
  }


  // --------------------------------------------------------
  // Discord Webhook
  // --------------------------------------------------------

  const webhookUrl =
    process.env.DISCORD_WEBHOOK_URL;


  if (!webhookUrl) {

    console.warn(
      'DISCORD_WEBHOOK_URL is not configured'
    );
  }


  // --------------------------------------------------------
  // 前回状態
  // --------------------------------------------------------

  const state =
    loadState();


  // --------------------------------------------------------
  // Chromium起動
  // --------------------------------------------------------

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


    // Cookie / JavaScript初期化待ち
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


    // ------------------------------------------------------
    // 各監視日をチェック
    // ------------------------------------------------------

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


      // ----------------------------------------------------
      // 非営業日は通知しない
      // ----------------------------------------------------

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


      // ----------------------------------------------------
      // 現状確認済み
      //
      // sale_status = 2
      // → 空きなし
      //
      // sale_status != 2
      // → 空き発生の可能性
      // ----------------------------------------------------

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


      // ----------------------------------------------------
      // 通知条件
      //
      // ・営業日
      // ・sale_status != 2
      // ・前回からsale_statusが変化
      // ----------------------------------------------------

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


      // ----------------------------------------------------
      // 現在状態を保存
      // ----------------------------------------------------

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
// 最終監視日取得
// ========================================================

function getLatestTargetDate() {

  if (
    !Array.isArray(CONFIG.TARGET_DATES) ||
    CONFIG.TARGET_DATES.length === 0
  ) {

    throw new Error(
      'TARGET_DATES is empty'
    );
  }


  return CONFIG.TARGET_DATES
    .slice()
    .sort()
    .at(-1);
}


// ========================================================
// 日本時間の今日の日付取得
//
// 例:
// 2026-09-23
// ========================================================

function getTodayJst() {

  const formatter =
    new Intl.DateTimeFormat(
      'en-CA',
      {
        timeZone:
          CONFIG.TIMEZONE,

        year:
          'numeric',

        month:
          '2-digit',

        day:
          '2-digit'
      }
    );


  const parts =
    formatter.formatToParts(
      new Date()
    );


  const year =
    parts.find(
      p => p.type === 'year'
    ).value;


  const month =
    parts.find(
      p => p.type === 'month'
    ).value;


  const day =
    parts.find(
      p => p.type === 'day'
    ).value;


  return `${year}-${month}-${day}`;
}


// ========================================================
// 監視期間終了判定
//
// 今日 > 最後のTARGET_DATE
//
// 最終日当日は最後まで監視する。
// 翌日になったらtrue。
// ========================================================

function isMonitoringPeriodOver() {

  const today =
    getTodayJst();


  const latestTargetDate =
    getLatestTargetDate();


  console.log(
    `Today JST: ${today}`
  );


  console.log(
    `Latest target date: ${latestTargetDate}`
  );


  return (
    today >
    latestTargetDate
  );
}


// ========================================================
// Workflow自動停止
// ========================================================

async function disableWorkflow() {

  const token =
    process.env.GITHUB_TOKEN;


  const repository =
    process.env.GITHUB_REPOSITORY;


  if (!token) {

    throw new Error(
      'GITHUB_TOKEN is not configured'
    );
  }


  if (!repository) {

    throw new Error(
      'GITHUB_REPOSITORY is not configured'
    );
  }


  const url =
    `https://api.github.com/repos/` +
    `${repository}/actions/workflows/` +
    `${CONFIG.WORKFLOW_FILE}/disable`;


  console.log(
    `Disable workflow: ${CONFIG.WORKFLOW_FILE}`
  );


  const response =
    await fetch(
      url,
      {
        method:
          'PUT',

        headers: {

          'Accept':
            'application/vnd.github+json',

          'Authorization':
            `Bearer ${token}`,

          'X-GitHub-Api-Version':
            '2026-03-10',

          'User-Agent':
            'nintendo-museum-monitor'
        }
      }
    );


  if (
    response.status !== 204
  ) {

    const text =
      await response.text();


    throw new Error(
      `Workflow disable failed: ` +
      `HTTP ${response.status} ` +
      text.slice(0, 500)
    );
  }


  console.log(
    'Workflow disabled successfully'
  );
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
// 状態読込
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


// ========================================================
// 状態保存
// ========================================================

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
