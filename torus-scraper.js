const axios = require('axios').default;
const cheerio = require('cheerio');
const qs = require('qs');

// --- CONFIGURATION ---
const CONFIG = {
    baseUrl: (process.env.BASE_URL || 'https://toruspowerconnect.com').replace(/\/$/, ''),
    username: process.env.TORUS_USERNAME,
    password: process.env.TORUS_PASSWORD,
    
    localUrl: (process.env.TORUS_LOCAL_URL || '').replace(/\/$/, ''),
    localScrapeInterval: parseInt(process.env.LOCAL_SCRAPE_INTERVAL) || 300,

    // Timezone Offset in Hours (e.g., -5 for EST, -6 for CST, 0 for UTC)
    deviceTimezoneOffset: parseFloat(process.env.DEVICE_TIMEZONE_OFFSET) || 0,

    // Back-off Configuration
    enableCloudBackoff: (process.env.ENABLE_CLOUD_BACKOFF || 'true').toLowerCase() === 'true',

    pushgatewayUrl: (process.env.PUSHGATEWAY_URL || '').replace(/\/$/, ''),
    jobName: process.env.JOB_NAME || 'torus_power_monitor',
    instanceName: process.env.INSTANCE_NAME || 'torus_primary',

    jobDurationSeconds: parseInt(process.env.JOB_DURATION) || 280,
    pollIntervalSeconds: parseInt(process.env.POLL_INTERVAL) || 15,

    loginFieldUser: 'ctl00$MainContent$UserName',
    loginFieldPass: 'ctl00$MainContent$Password'
};

// --- STATE ---
let sessionCookies = [];
let lastLocalScrapeTime = 0; 
let cachedLocalData = null; 
let lastCloudCheckTime = 0; 
let lastCloudSuccessTime = 0; 

// --- CLIENT SETUP ---
const client = axios.create({
    headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Cache-Control': 'max-age=0'
    },
    validateStatus: status => status >= 200 && status < 500,
    maxRedirects: 0,
    timeout: 5000 
});

client.interceptors.response.use(response => {
    let setCookie = response.headers['set-cookie'];
    if (setCookie) {
        if (!Array.isArray(setCookie)) setCookie = [setCookie];
        setCookie.forEach(cookie => {
            const cookieParts = cookie.split(';');
            const keyVal = cookieParts[0];
            const name = keyVal.split('=')[0];
            sessionCookies = sessionCookies.filter(c => !c.startsWith(name + '='));
            sessionCookies.push(keyVal);
        });
    }
    return response;
});

client.interceptors.request.use(config => {
    if (config.url.includes(CONFIG.baseUrl) && sessionCookies.length > 0) {
        config.headers['Cookie'] = sessionCookies.join('; ');
    }
    return config;
});

// --- HELPERS ---
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchWithRedirects(startUrl) {
    let url = startUrl;
    let res = await client.get(url);
    let redirects = 0;
    while (res.status >= 300 && res.status < 400 && redirects < 10) {
        const loc = res.headers.location;
        if (!loc) break;
        if (loc.startsWith('http')) url = loc;
        else url = new URL(loc, new URL(url).origin).toString();
        res = await client.get(url);
        redirects++;
    }
    return { response: res, finalUrl: url };
}

function getHiddenFields(html) {
    const $ = cheerio.load(html);
    const fields = {};
    const keys = ['__VIEWSTATE', '__EVENTVALIDATION', '__VIEWSTATEGENERATOR', '__EVENTTARGET', '__EVENTARGUMENT'];
    keys.forEach(id => {
        const val = $(`#${id}`).val();
        if (val) fields[id] = val;
    });
    return fields;
}

// --- LOCAL SCRAPER ---
async function scrapeLocalDevice() {
    if (!CONFIG.localUrl) return null;
    
    try {
        console.log(`   [Fallback] Fetching data from Local Device: ${CONFIG.localUrl}`);
        const res = await client.get(CONFIG.localUrl, {
             httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
        });
        
        const $ = cheerio.load(res.data);
        const localData = {};

        $('tr').each((i, row) => {
            const cells = $(row).find('td');
            if (cells.length >= 2) {
                let key = cells.eq(0).text().trim(); 
                let valStr = cells.eq(1).text().trim(); 
                const val = parseFloat(valStr.replace(/[^\d\.]/g, ''));

                if (!isNaN(val)) {
                    if (/voltage\s*in/i.test(key)) localData.inputVoltage = val;
                    else if (/voltage\s*out/i.test(key)) localData.outputVoltage = val;
                    else if (/current\s*out/i.test(key)) localData.outputCurrent = val;
                    else if (/power\s*out/i.test(key)) {
                        if (valStr.toLowerCase().includes('kw')) {
                            val = val * 1000;
                        }
                        localData.outputPower = val;
                    }
                }
            }
        });

        if (localData.inputVoltage !== undefined) return localData;
        console.warn("   [Fallback Warn] Parsed table but found no matching metrics.");
        
    } catch (e) {
        console.error(`   [Fallback Error] Local scrape failed: ${e.message}`);
    }
    return null;
}

// --- CLOUD SCRAPER ---
function extractCloudMetrics(html) {
    const results = {};
    const $ = cheerio.load(html);

    const getSpanVal = (suffix) => {
        const el = $(`span[id$="${suffix}"]`);
        if (el.length > 0 && el.text().trim().length > 0) {
            const num = parseFloat(el.text().replace(/[^\d\.]/g, ''));
            return isNaN(num) ? null : num;
        }
        return null;
    };

    const getGaugeVal = (idPartial) => {
        const regex = new RegExp(`${idPartial}[\\s\\S]*?value":\\s*([\\d\\.]+)`);
        const match = html.match(regex);
        return match ? parseFloat(match[1]) : null;
    };

    const getSpanText = (suffix) => {
        const el = $(`span[id$="${suffix}"]`);
        return el.length > 0 ? el.text().trim() : null;
    };

    results.inputVoltage = getSpanVal('lblInputVoltageValue') || getGaugeVal('RadRadialGaugeInputVoltage');
    results.outputVoltage = getSpanVal('lblOutputVoltageValue') || getGaugeVal('RadRadialGaugeOutputVoltage');
    results.outputCurrent = getSpanVal('lblOutputCurrentValue') || getGaugeVal('RadRadialGaugeOutputCurrent');
    results.thd = getSpanVal('lblOutputTHD') || getGaugeVal('RadRadialGaugeTHD');
    
    const powerSpan = getSpanVal('lblOutputPowerValue');
    if (powerSpan !== null) {
        results.outputPower = powerSpan; 
    } else {
        const powerGauge = getGaugeVal('RadRadialGaugeOutputPower');
        results.outputPower = powerGauge !== null ? powerGauge * 1000 : null; 
    }

    // --- TIMEZONE HANDLING ---
    const lastSeenStr = getSpanText('lblSystemStatusTS');
    if (lastSeenStr) {
        const rawTs = Date.parse(lastSeenStr);
        if (!isNaN(rawTs)) {
            const offsetMs = CONFIG.deviceTimezoneOffset * 60 * 60 * 1000;
            const correctedTs = rawTs - offsetMs;
            results.deviceTimestamp = Math.floor(correctedTs / 1000);
        }
    }

    return results;
}

async function run() {
    try {
        console.log(`Starting Job. Duration: ${CONFIG.jobDurationSeconds}s, Interval: ${CONFIG.pollIntervalSeconds}s`);
        if (CONFIG.localUrl) console.log(`Local Fallback Enabled: ${CONFIG.localUrl} (Rate Limit: ${CONFIG.localScrapeInterval}s)`);
        if (CONFIG.deviceTimezoneOffset !== 0) console.log(`Timezone Offset Applied: ${CONFIG.deviceTimezoneOffset} hours`);
        console.log(`Cloud Back-off Enabled: ${CONFIG.enableCloudBackoff}`);

        console.log("1. Starting Auth Flow...");
        let { response: pageRes, finalUrl: currentUrl } = await fetchWithRedirects(CONFIG.baseUrl);

        let $ = cheerio.load(pageRes.data);
        if ($(`input[name="${CONFIG.loginFieldUser}"]`).length === 0) {
            console.log("   Username not found. Forcing navigation to /Default...");
            currentUrl = `${CONFIG.baseUrl}/Default`;
            const result = await fetchWithRedirects(currentUrl);
            pageRes = result.response;
            currentUrl = result.finalUrl;
            $ = cheerio.load(pageRes.data);
        }

        const loginFields = getHiddenFields(pageRes.data);
        if (!loginFields['__VIEWSTATE']) throw new Error("Cannot login: ViewState missing.");

        let loginBtnName = 'ctl00$MainContent$LoginButton'; 
        const submitBtn = $('input[type="submit"]').first();
        if (submitBtn.length > 0) loginBtnName = submitBtn.attr('name');

        const loginPayload = {
            ...loginFields,
            [CONFIG.loginFieldUser]: CONFIG.username,
            [CONFIG.loginFieldPass]: CONFIG.password,
            [loginBtnName]: 'Log In' 
        };
        
        console.log(`   Posting credentials to: ${currentUrl}`);
        const loginPostRes = await client.post(currentUrl, qs.stringify(loginPayload), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': currentUrl }
        });
        
        console.log(`   Login Status: ${loginPostRes.status}`);
        
        if (loginPostRes.status === 200) {
            const $fail = cheerio.load(loginPostRes.data);
            const failureText = $fail('.failureNotification, .validation-summary-errors').text().trim();
            if (failureText) {
                console.error(`[LOGIN FAILURE] Server replied: "${failureText}"`);
                process.exit(1);
            }
        }

        console.log("2. Polling Loop (Hybrid)...");
        const loopStart = Date.now();
        let iteration = 0;
        
        // Initialize success time to now so backoff doesn't trigger immediately
        lastCloudSuccessTime = Math.floor(Date.now() / 1000); 
        let cloudWasSkipped = false;

        while ((Date.now() - loopStart) < (CONFIG.jobDurationSeconds * 1000)) {
            iteration++;
            const dataUrl = `${CONFIG.baseUrl}/MemberPages/LiveData.aspx`; 
            
            try {
                let metrics = {};
                let skipCloud = false;
                const nowSeconds = Math.floor(Date.now() / 1000);

                // --- CLOUD BACK-OFF LOGIC ---
                // Only run if feature enabled
                if (CONFIG.enableCloudBackoff) {
                    const outageDuration = nowSeconds - lastCloudSuccessTime;
                    
                    if (outageDuration > 120) {
                        const backoffTime = Math.floor(outageDuration / 2);
                        const timeSinceCheck = nowSeconds - lastCloudCheckTime;
                        
                        if (timeSinceCheck < backoffTime) {
                            console.log(`   [Back-off] Skipping cloud check. Outage: ${outageDuration}s. Next check in ${backoffTime - timeSinceCheck}s.`);
                            skipCloud = true;
                            cloudWasSkipped = true;
                        }

                        if (cloudWasSkipped && !skipCloud) {
                            console.log(`   [Back-off] Back-off period Expired. Checking Cloud.`);
                            cloudWasSkipped = false;
                        }
                    }
                }

                if (!skipCloud) {
                    const { response: livePageRes } = await fetchWithRedirects(dataUrl);
                    if (livePageRes.request.path && livePageRes.request.path.includes('Login')) {
                         console.warn("   [WARN] Redirected to Login.");
                    }
                    metrics = extractCloudMetrics(livePageRes.data);
                    lastCloudCheckTime = nowSeconds;
                }
                
                let dataSource = 0; 
                let isCloudStale = false;
                
                if (!skipCloud && metrics.deviceTimestamp) {
                    const secondsAgo = nowSeconds - metrics.deviceTimestamp;
                    
                    if (iteration === 1) {
                        const devDate = new Date(metrics.deviceTimestamp * 1000).toISOString();
                        console.log(`   [Time Check] Device: ${devDate} | Diff: ${secondsAgo.toFixed(0)}s`);
                    }

                    if (secondsAgo > 60) {
                        isCloudStale = true;
                        dataSource = 2; 
                    } else {
                        lastCloudSuccessTime = nowSeconds;
                        cachedLocalData = null;
                        dataSource = 0;
                    }
                } else {
                    isCloudStale = true;
                    dataSource = 2; 
                }

                if (isCloudStale && CONFIG.localUrl) {
                    const nowSeconds = Math.floor(Date.now() / 1000);
                    let didFreshScrape = false;
                    
                    if ((nowSeconds - lastLocalScrapeTime) > CONFIG.localScrapeInterval) {
                        if (metrics.deviceTimestamp && !skipCloud) {
                             console.log(`   [Stale] Cloud data is ${(Date.now()/1000 - metrics.deviceTimestamp).toFixed(0)}s old. Triggering Local Scrape...`);
                        }
                        lastLocalScrapeTime = nowSeconds; 
                        
                        const freshLocal = await scrapeLocalDevice();
                        if (freshLocal) {
                            cachedLocalData = freshLocal;
                            console.log("   [Fallback Success] Updated Local Cache.");
                            didFreshScrape = true;
                        }
                    }

                    if (cachedLocalData) {
                        metrics.inputVoltage = cachedLocalData.inputVoltage;
                        metrics.outputVoltage = cachedLocalData.outputVoltage;
                        metrics.outputCurrent = cachedLocalData.outputCurrent;
                        metrics.outputPower = cachedLocalData.outputPower;
                        dataSource = didFreshScrape ? 1 : 3; 
                    }
                }

                const foundAny = metrics.inputVoltage !== null || metrics.deviceTimestamp !== undefined;

                if (foundAny) {
                    let output = '';
                    const add = (n, v) => { if (v !== null && v !== undefined) output += `${n}{instance="${CONFIG.instanceName}", job="${CONFIG.jobName}"} ${v}\n`; };
                    
                    add('torus_input_voltage_volts', metrics.inputVoltage);
                    add('torus_output_voltage_volts', metrics.outputVoltage);
                    add('torus_output_current_amps', metrics.outputCurrent);
                    add('torus_output_power_watts', metrics.outputPower);
                    add('torus_output_thd_percent', metrics.thd);
                    add('torus_device_last_seen_timestamp', metrics.deviceTimestamp);
                    add('torus_scrape_last_success_timestamp', nowSeconds);
                    add('torus_data_source', dataSource);

                    const pushUrl = `${CONFIG.pushgatewayUrl}/metrics/job/${CONFIG.jobName}`;
                    await axios.post(pushUrl, output + '\n', { headers: { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' }});
                    
                    let sourceLabel = 'CLOUD';
                    if (dataSource === 1) sourceLabel = 'LOCAL_FRESH';
                    if (dataSource === 2) sourceLabel = 'CLOUD_STALE';
                    if (dataSource === 3) sourceLabel = 'LOCAL_CACHED';
                    console.log(`[${new Date().toISOString()}] Iteration ${iteration}: Data pushed (Source: ${sourceLabel}).`);
                } else {
                    console.warn(`[Iteration ${iteration}] No data available.`);
                }

            } catch (e) {
                console.error(`Error Iteration ${iteration}: ${e.message}`);
            }

            if ((Date.now() - loopStart) < (CONFIG.jobDurationSeconds * 1000)) {
                const expectedNextTick = loopStart + (iteration * CONFIG.pollIntervalSeconds * 1000);
                const timeToWait = expectedNextTick - Date.now();
                if (timeToWait > 0) await sleep(timeToWait);
            }
        }
        process.exit(0);
    } catch (e) {
        console.error("Fatal Error:", e.message);
        process.exit(1);
    }
}

run();
