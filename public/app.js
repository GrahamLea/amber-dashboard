// Copyright (c) 2022 Graham Lea. All rights reserved.
const TEST_MODE = false;
const TEST_ANIMATION = false;
const TWENTY_FOUR_HOURS_IN_MS = 24 * 60 * 60 * 1000;
const DEFAULT_HOURS_FORECAST_TO_SHOW = 18;
const DEFAULT_HIGH_PRICE_LIMIT = 100;

const BAR_THRESHOLD_1 = 20;
const BAR_THRESHOLD_2 = 40;
const BAR_THRESHOLD_3 = 80;
const BAR_THRESHOLD_4 = 1700;

// If the last successful price load is older than this, warn that the screen may be out of date
const STALE_DATA_MINUTES = 5;

// Metered usage only arrives about a day late, so the month's cost needn't be fetched often
const USAGE_REFRESH_MINUTES = 60;

// When the sun is up is learnt from the house's own meter: over the last couple of weeks, the share of
// days each half-hour exported more solar than it imported. Around the sunniest half-hour, the run of
// half-hours exporting on at least SUN_SHARE of days is "sun" (green, free); the half-hours either side
// exporting on at least LOW_SUN_SHARE of days are "low sun" (blue).
const SOLAR_PROFILE_DAYS = 14;
const SOLAR_PROFILE_MIN_DAYS = 5;
const SUN_SHARE = 0.5;
const LOW_SUN_SHARE = 0.25;

// Error codes from the server's /api/prices proxy (nginx/default.conf)
const SERVER_ERRORS = {
    "not-configured": "The server has no Amber API key set up yet (see README)",
    "amber-rejected-key": "Amber rejected the server's API key",
    "rate-limited": "Too many requests to Amber, retrying shortly",
    "amber-unavailable": "Amber's servers aren't responding",
    "bad-request": "Bad request",
};

// How Amber's price descriptors map onto the traffic lights
const DESCRIPTOR_RATINGS = {
    negative: "green",
    extremelyLow: "green",
    veryLow: "green",
    low: "green",
    neutral: "amber",
    high: "red",
    spike: "spike",
};

// Plain-English "what should I do right now?" for someone glancing at the wall. The word goes in the light.
const ADVICE = {
    paid: {
        word: "FREE",
        headline: "Paid to use power",
        detail: "Run everything you can now: oven, washing, dryer, dishwasher, hot water, charge the car.",
    },
    sun: {
        word: "FREE",
        headline: "Sun's up: power is free",
        detail: "Do the big jobs now: washing, dryer, dishwasher, oven, hot water, charge the car.",
    },
    green: {
        word: "GOOD",
        headline: "Good time to use power",
        detail: "Go ahead: oven and stove cooking, washing, dryer, dishwasher, heating or cooling, charging.",
    },
    blue: {
        word: "OK",
        headline: "Low sun: small jobs only",
        detail: "Lights, TV and quick cooking are fine. Save washing, the dryer and long oven cooking for green.",
    },
    amber: {
        word: "WAIT",
        headline: "Go easy",
        detail: "Lights, TV and cooking dinner are fine. Leave washing, the dryer and the dishwasher for green.",
    },
    red: {
        word: "AVOID",
        headline: "Expensive: avoid big loads",
        detail: "No long oven or stove cooking, dryer, or heaters. Wait for green if you can.",
    },
    spike: {
        word: "OFF",
        headline: "Price spike: switch off",
        detail: "Very expensive right now. Turn off everything you can (oven, stove, dryer, heaters, aircon) until it passes.",
    },
    unknown: {
        word: "?",
        headline: "Price unknown",
        detail: "Waiting for prices from Amber.",
    },
};

const decimalFormatTrimmed = new Intl.NumberFormat("en-AU",
    {style: "decimal", minimumFractionDigits: 1, maximumFractionDigits: 1});
const decimalFormatFull = new Intl.NumberFormat("en-AU",
    {style: "decimal", minimumFractionDigits: 2, maximumFractionDigits: 2});
const dollarFormat = new Intl.NumberFormat("en-AU", {style: "currency", currency: "AUD"});

const DateTime = luxon.DateTime;

function nowNemTime() {
    return DateTime.now().setZone('UTC+10');
}

function flashExtremeElements() {
    const nowMs = Date.now();
    const on = (nowMs / 1000) % 2 <= 1;
    document.querySelectorAll('.spike, .superCheap').forEach(bar => {
        if (on) {
            bar.classList.add("highlight");
        } else {
            bar.classList.remove("highlight");
        }
    });
}

setInterval(flashExtremeElements, 1000);

// Courtesy of Houshalter on SO: https://stackoverflow.com/a/29641185/243104
const audioCtx = new (window.AudioContext || window.webkitAudioContext || window.audioContext);

// Chrome won't play sound until the page has had a user gesture, so un-suspend on the first tap
function unlockAudio() {
    if (audioCtx.state === "suspended") {
        audioCtx.resume().catch(e => console.log("Could not resume audio", e));
    }
}

document.addEventListener("click", unlockAudio);
document.addEventListener("touchend", unlockAudio);

async function loadTestData() {
    const data = await (await fetch("test-data.json")).json();
    // Overwrite the timestamps to make them go from now forwards...
    let time = DateTime.now().setZone("UTC")
    time = time.set({minutes: (time.minute - time.minute % 5), seconds: 0, milliseconds: 0})
    for (const interval of data.filter(i => i.channelType === "general" && ["CurrentInterval", "ForecastInterval"].includes(i.type))) {
        interval.startTime = time.set({minute: interval.duration === 30 ? time.minute >= 30 ? 30 : 0 : time.minute}).toISO()
        time = time.plus({minutes: interval.duration})
        interval.endTime = time.toISO()
    }
    return data
}

async function beep({duration, frequency, volume, type}) {
    const oscillator = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(audioCtx.destination);

    if (volume) {
        gainNode.gain.value = volume;
    }
    if (frequency) {
        oscillator.frequency.value = frequency;
    }
    if (type) {
        oscillator.type = type;
    }
    const promise = new Promise(resolve => {
        oscillator.onended = resolve
    })

    oscillator.start(audioCtx.currentTime);
    oscillator.stop(audioCtx.currentTime + ((duration || 500) / 1000));
    return promise;
}

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

async function playAlert() {
    await beep({duration: 300, frequency: 783.99, volume: 0.3, type: 'triangle'})
    await sleep(80)
    await beep({duration: 300, frequency: 783.99, volume: 0.3, type: 'triangle'})
    await sleep(80)
    await beep({duration: 150, frequency: 783.99, volume: 0.3, type: 'triangle'})
}

Vue.component('price', {
    props: ['interval', 'trimHighPrices'],
    template: '#price-template',

    methods: {
        formattedPrice(centsPerKwh) {
            const absCents = Math.abs(centsPerKwh);
            if (absCents < 100) {
                return absCents
            } else if (absCents < 1000) {
                return this.trimHighPrices
                    ? decimalFormatTrimmed.format(absCents / 100)
                    : decimalFormatFull.format(absCents / 100);
            } else {
                return Math.round(absCents / 100)
            }
        },
    }
});

Vue.component('time-display', {
    props: ['time', 'full'],
    template: '#time-template',

    computed: {
        dateTime() {
            return (DateTime.isDateTime(this.time) ? this.time : DateTime.fromISO(this.time)).toLocal()
        },
        isHour() {
            return this.dateTime.minute === 0
        },
        formattedTime() {
            const [timeStr, ampm] = this.dateTime.toLocaleString({
                hour: 'numeric',
                minute: this.isHour && !this.full ? undefined : 'numeric',
                hour12: true
            }).split(/\s+/); // newer Chrome puts a narrow no-break space before am/pm
            return {
                timeStr,
                ampm
            };
        },
    }
});

const app = new Vue({
    el: "#app",
    template: "#dashboard-template",
    data: function () {
        return {
            initialising: true,
            configMode: false,
            loadedTime: new Date(),
            lastRequestMinute: null,
            intervalsRequestError: null,
            rawIntervals: null,
            rawUsage: null,
            usageLoadedAt: null,
            hoursForecastToShow: 18,
            highPriceLimit: 100,
            greenMaxCents: "",
            redMinCents: "",
            playAlerts: true,
            lastLoadedAt: null,
            fullscreenSupported: !!(document.documentElement.requestFullscreen
                || document.documentElement.webkitRequestFullscreen),
            isFullscreen: false,
            wakeLock: null,
            dateTimeNow: DateTime.now(),
            hourMinuteNow: DateTime.now().set({seconds: 0, milliseconds: 0}),
            width: 900,
            height: 600,
        }
    },
    computed: {
        intervals() {
            return this.rawIntervals?.map(
                ({startTime, endTime, perKwh, ...interval}) =>
                    ({
                        ...interval,
                        startDateTimeLocal: DateTime.fromISO(startTime).toLocal(),
                        endDateTimeLocal: DateTime.fromISO(endTime).toLocal(),
                        priceCents: Math.round(perKwh)
                    })
            )
        },
        showOddTimes() {
            return (this.width / this.futureIntervals?.length ?? 20) > 17
        },
        trimHighCurrentAndNextPrices() {
            return this.width / this.height < 1.1;
        },
        generalIntervals() {
            return this.intervals?.filter(({channelType}) => channelType === "general");
        },
        shouldFakeNextInterval() {
            return this.actualCurrentGeneralInterval
                && this.hourMinuteNow >= this.actualCurrentGeneralInterval.endDateTimeLocal
        },
        actualCurrentGeneralInterval() {
            return this.generalIntervals?.filter(({type}) => type === "CurrentInterval")[0];
        },
        currentGeneralInterval() {
            if (this.shouldFakeNextInterval) {
                return this.actualNextGeneralInterval
            }
            return this.actualCurrentGeneralInterval;
        },
        actualNextGeneralInterval() {
            return this.forecastGeneralIntervalsSorted ? this.forecastGeneralIntervalsSorted[0] : null;
        },
        nextGeneralInterval() {
            return this.shouldFakeNextInterval && this.forecastGeneralIntervalsSorted
                ? this.forecastGeneralIntervalsSorted[1]
                : this.actualNextGeneralInterval;
        },
        currentIntervalRemainingMinutes() {
            return this.currentGeneralInterval ?
                Math.max(0, this.currentGeneralInterval.endDateTimeLocal.diff(this.dateTimeNow, 'minutes').minutes) :
                0;
        },
        currentIntervalRemainingMinutesForDisplay() {
            return Math.floor(this.currentIntervalRemainingMinutes + 1);
        },
        currentIntervalRemainingPercentage() {
            return this.currentGeneralInterval ?
                this.currentIntervalRemainingMinutes / this.currentGeneralInterval.duration * 100
                : 0;
        },
        forecastGeneralIntervalsSorted() {
            return this.generalIntervals ?
                _(this.generalIntervals)
                    .filter(interval => interval.type === "ForecastInterval")
                    .sortBy("nemTime")
                    .value()
                : null
        },
        futureIntervals() {
            return this.forecastGeneralIntervalsSorted ?
                _(this.forecastGeneralIntervalsSorted)
                    .slice(this.shouldFakeNextInterval ? 2 : 1)
                    .filter(i => i.startDateTimeLocal.diffNow('hours').hours <= this.hoursForecastToShow)
                    .value()
                : null
        },
        upcomingIntervals() {
            // Every interval after the current one, in order (i.e. next + the chart)
            return this.forecastGeneralIntervalsSorted ?
                this.forecastGeneralIntervalsSorted
                    .slice(this.shouldFakeNextInterval ? 1 : 0)
                    .filter(i => i.startDateTimeLocal.diffNow('hours').hours <= this.hoursForecastToShow)
                : []
        },
        currentRating() {
            return this.rating(this.currentGeneralInterval);
        },
        ratingWord() {
            return this.advice.word;
        },
        advice() {
            const interval = this.currentGeneralInterval;
            if (interval && this.currentRating === "green") {
                if (interval.priceCents < 0) return ADVICE.paid;
                if (this.sunPeriod(interval) === "sun") return ADVICE.sun;
            }
            return ADVICE[this.currentRating];
        },
        timing() {
            // Answers "how long have I got?" when green, and "when can I cook?" otherwise
            if (!this.currentGeneralInterval) return null;
            const isGreen = this.currentRating === "green";
            const change = this.upcomingIntervals.find(i => (this.rating(i) === "green") !== isGreen);
            const hours = Math.round(this.hoursForecastToShow);
            const green = this.solarSlots ? "Free" : "Green";
            if (!change) {
                return isGreen
                    ? {label: `${green} for`, text: `${hours}+ hours`}
                    : {label: `Next ${green.toLowerCase()}`, text: `Not in next ${hours} h`};
            }
            return {
                label: isGreen ? `${green} until` : `${green} from`,
                time: change.startDateTimeLocal,
                sub: this.formatDurationFromNow(change.startDateTimeLocal),
            };
        },
        monthCost() {
            // Month to date, as metered: every channel's cost (cents, incl. GST), so feed-in credits
            // net off. Excludes daily supply charges and the Amber membership fee. Meter data runs a day
            // or so behind, so until this month has any, show last month's.
            const thisMonth = DateTime.now().startOf("month");
            for (const month of [thisMonth, thisMonth.minus({months: 1})]) {
                const [from, to] = [month.toISODate(), month.endOf("month").toISODate()];
                const usage = this.rawUsage?.filter(({date}) => date >= from && date <= to);
                if (usage?.length) {
                    return {
                        label: month === thisMonth ? "this month" : `in ${month.toFormat("LLLL")}`,
                        text: dollarFormat.format(_.sumBy(usage, "cost") / 100),
                        upTo: DateTime.fromISO(_.maxBy(usage, "date").date).toFormat("d LLL"),
                    };
                }
            }
            return null;
        },
        solarSlots() {
            // For each half-hour of the day (local time): "sun", "lowSun" or null. Null overall until
            // there's enough meter data, or if the panels rarely cover the house (e.g. deep winter).
            if (!this.rawUsage?.length) return null;
            const since = DateTime.now().minus({days: SOLAR_PROFILE_DAYS}).toISODate();
            const net = {};   // "date|slot" -> kWh exported minus kWh imported
            for (const {date, startTime, channelType, kwh} of this.rawUsage) {
                if (date < since || channelType === "controlledLoad") continue;
                const start = DateTime.fromISO(startTime).toLocal();
                const key = `${start.toISODate()}|${start.hour * 2 + Math.floor(start.minute / 30)}`;
                net[key] = (net[key] || 0) + (channelType === "feedIn" ? 1 : -1) * Math.abs(kwh);
            }
            const days = _.uniq(Object.keys(net).map(key => key.split("|")[0]));
            if (days.length < SOLAR_PROFILE_MIN_DAYS) return null;
            const share = _.range(48).map(slot => days.filter(day => net[`${day}|${slot}`] > 0).length / days.length);
            const peak = share.indexOf(_.max(share));
            if (share[peak] < SUN_SHARE) return null;
            const spread = minShare => {
                let [from, to] = [peak, peak];
                while (from > 0 && share[from - 1] >= minShare) from--;
                while (to < 47 && share[to + 1] >= minShare) to++;
                return [from, to];
            };
            const [sunFrom, sunTo] = spread(SUN_SHARE);
            const [lowFrom, lowTo] = spread(LOW_SUN_SHARE);
            return share.map((_s, slot) =>
                slot >= sunFrom && slot <= sunTo ? "sun" : slot >= lowFrom && slot <= lowTo ? "lowSun" : null);
        },
        dataIsStale() {
            return !!this.lastLoadedAt
                && this.dateTimeNow.diff(this.lastLoadedAt, 'minutes').minutes > STALE_DATA_MINUTES;
        },
        significantPriceChangeIntervals() {
            let lastSignificantPrice = null

            return _(this.futureIntervals).map((interval, index) => {
                if (lastSignificantPrice === null) {
                    lastSignificantPrice = interval.priceCents
                    return index
                }
                const priceA = interval.priceCents;
                const priceB = lastSignificantPrice;
                const diff = Math.abs(priceA - priceB)
                const significantDiff = Math.max(2, Math.min(priceA, priceB) / 10)
                if ((priceA < 0 && priceB > 2) || diff > significantDiff) {
                    lastSignificantPrice = interval.priceCents
                    return index
                } else {
                    return null
                }
            }).compact().value()
        },
        anyFutureNegativePrices() {
            return _(this.futureIntervals).some(i => i.priceCents < 0)
        },
        maxFutureNegativePrice() {
            return _(this.futureIntervals)
                    ?.map(i => i.priceCents)
                    .filter(p => p < 0)
                    .max()
                ?? 0
        },
        maxNegativeBarPrice() {
            return Math.min(100, Math.abs(this.maxFutureNegativePrice))
        },
        positiveBarSpaceRatio() {
            return 1 - (0.25 * this.maxNegativeBarPrice / 100)
        }
    },
    methods: {
        async loadIntervals() {
            this.intervalsRequestError = null;
            const startDate = nowNemTime().set({minutes: 0}).toISODate();
            const endDate = nowNemTime().plus({hours: (this.hoursForecastToShow + 1)}).toISODate();
            // The web server proxies this to Amber and adds the API key and site itself
            // (from a Kubernetes Secret), so no credentials ever reach the browser.
            const url = `api/prices?startDate=${startDate}&endDate=${endDate}`;
            console.log("Requesting forecasts", {
                hoursForecastToShow: this.hoursForecastToShow,
                startDate,
                endDate,
                url
            });
            if (TEST_MODE) {
                this.rawIntervals = await loadTestData();
                this.lastLoadedAt = DateTime.now();
                // For testing...
                this.currentGeneralInterval.priceCents = 888;
                this.currentGeneralInterval.descriptor = 'spike';
                this.forecastGeneralIntervalsSorted[0].priceCents = 888;
                this.forecastGeneralIntervalsSorted[0].descriptor = "veryLow";
                this.forecastGeneralIntervalsSorted[10].priceCents = 700;
                this.forecastGeneralIntervalsSorted[10].descriptor = "test";
                // this.forecastGeneralIntervalsSorted[1].priceCents = 10;
                // this.forecastGeneralIntervalsSorted[1].descriptor = "veryLow";
                this.forecastGeneralIntervalsSorted[3].priceCents = -245;
                this.forecastGeneralIntervalsSorted[3].descriptor = "veryLow";
                this.possiblyPlayAlert()
                console.log({
                    maxNegativeBarPrice: this.maxNegativeBarPrice,
                    positiveBarSpaceRatio: this.positiveBarSpaceRatio
                })
                return
            }
            try {
                const response = await fetch(url, {
                    headers: {"Accept": "application/json"},
                    credentials: "same-origin",
                    cache: "no-store",
                })
                if (response.ok) {
                    const responseJson = await response.json();
                    console.log(`Loaded ${responseJson.length} intervals`)
                    this.rawIntervals = responseJson
                    this.lastLoadedAt = DateTime.now()
                    this.possiblyPlayAlert()
                    return true
                } else {
                    const body = await response.json().catch(() => ({}));
                    this.intervalsRequestError = SERVER_ERRORS[body.error] || `Server response: ${response.status}`;
                    return false
                }
            } catch (e) {
                this.intervalsRequestError = `${e}`;
            }
        },
        async loadUsage() {
            // This month (for its cost) and the last couple of weeks (for when the sun's up). Amber serves
            // at most 7 days of usage per request, so ask in fixed weeks of each month (1st-7th, 8th-14th,
            // ...): the server only accepts these, and past weeks stay cached.
            const today = DateTime.now();
            // Early in the month, all of last month too: its total shows until this month's meter data arrives
            const monthStart = today.day <= 7 ? today.startOf("month").minus({months: 1}) : today.startOf("month");
            const from = DateTime.min(monthStart, today.minus({days: SOLAR_PROFILE_DAYS}).startOf("day"));
            const urls = [];
            for (let month = from.startOf("month"); month <= today; month = month.plus({months: 1})) {
                for (let start = month; start <= today && start.hasSame(month, "month"); start = start.plus({days: 7})) {
                    const end = DateTime.min(start.plus({days: 6}), today, month.endOf("month"));
                    if (end >= from) {
                        urls.push(`api/usage?startDate=${start.toISODate()}&endDate=${end.toISODate()}`);
                    }
                }
            }
            try {
                const weeks = await Promise.all(urls.map(async url => {
                    const response = await fetch(url, {
                        headers: {"Accept": "application/json"},
                        credentials: "same-origin",
                        cache: "no-store",
                    })
                    if (!response.ok) {
                        throw new Error(`Server response: ${response.status} for ${url}`);
                    }
                    return response.json();
                }));
                this.rawUsage = weeks.flat();
                this.usageLoadedAt = today;
            } catch (e) {
                console.log("Could not load usage", e);
            }
        },
        async maybeLoadIntervals() {
            this.dateTimeNow = DateTime.now()
            // Daily refresh to pick up a redeployed page. Skipped in browser (tap-to-)full screen, because a
            // reload would drop out of it and nobody is there to tap it back in. The installed app stays
            // full screen across reloads, so that still refreshes.
            if (new Date() - this.loadedTime > TWENTY_FOUR_HOURS_IN_MS && !this.inBrowserFullscreen()) {
                location.reload();
            }
            const minuteNow = this.dateTimeNow.minute;
            if (this.lastRequestMinute === null || (minuteNow !== this.lastRequestMinute && this.dateTimeNow.second > 20)) {
                this.lastRequestMinute = minuteNow;
                await this.loadIntervals();
            }
            if (!TEST_MODE && (!this.usageLoadedAt
                || this.dateTimeNow.diff(this.usageLoadedAt, 'minutes').minutes > USAGE_REFRESH_MINUTES
                || !this.dateTimeNow.hasSame(this.usageLoadedAt, 'month'))) {
                this.usageLoadedAt = this.dateTimeNow;  // don't retry every second while the request is out
                this.loadUsage();
            }
            if (TEST_ANIMATION && this.generalIntervals && (new Date().getSeconds() % 5 === 0)) {
                _(this.generalIntervals).forEach(interval => {
                    if (Math.random() < 0.2) {
                        interval.priceCents = interval.priceCents + Math.round(15 * (Math.random() - 0.5))
                    }
                    if (Math.random() < 0.2) {
                        interval.descriptor = _.sample([
                            'extremelyLow', 'veryLow', 'low', 'neutral', 'high', 'spike'
                        ])
                    }
                })
                this.rawIntervals = [...this.rawIntervals]
                this.hoursForecastToShow += Math.random() < 0.5 ? 1 : -1
            }
        },
        possiblyPlayAlert() {
            // Play an alert every 5 minutes if there's currently a spike
            let isCurrentlyASpike = this.rating(this.currentGeneralInterval) === "spike";
            let isZerothMinute = (new Date().getMinutes() % 5) < 1;
            if (this.playAlerts && isCurrentlyASpike && isZerothMinute) {
                playAlert();
            }
        },
        descriptor(interval) {
            if (!interval) {
                return 'unknown'
            }
            if (interval.spikeStatus === "spike" ||
                interval.spikeStatus === "potential" ||
                interval.priceCents > this.highPriceLimit) {
                return "spike"
            }
            return interval.descriptor || 'unknown'
        },
        rating(interval) {
            // spike / red / green / blue / amber / unknown. Expensive always wins; otherwise, once the
            // sun's hours are known, they decide: sun = green (free), low sun = blue, no sun = amber.
            const descriptor = this.descriptor(interval);
            if (descriptor === "spike") {
                return "spike"
            }
            if (descriptor === "unknown") {
                return "unknown"
            }
            if (typeof this.greenMaxCents === "number" && interval.priceCents <= this.greenMaxCents) {
                return "green"
            }
            if (typeof this.redMinCents === "number" && interval.priceCents >= this.redMinCents) {
                return "red"
            }
            if (interval.priceCents <= 0) {
                return "green"
            }
            if (!this.solarSlots || DESCRIPTOR_RATINGS[descriptor] === "red") {
                return DESCRIPTOR_RATINGS[descriptor] || "unknown"
            }
            // The sun only makes power free when the grid is cheap too: at a dearer price (e.g. a peak
            // tariff starting mid-afternoon), a big load that outruns the panels costs real money, so the
            // sun lifts the rating one step instead
            const cheap = DESCRIPTOR_RATINGS[descriptor] === "green";
            switch (this.sunPeriod(interval)) {
                case "sun":
                    return cheap ? "green" : "blue"
                case "lowSun":
                    return cheap ? "blue" : "amber"
                default:
                    return "amber"
            }
        },
        sunPeriod(interval) {
            const start = interval.startDateTimeLocal;
            return this.solarSlots?.[start.hour * 2 + Math.floor(start.minute / 30)] ?? null
        },
        isSuperCheap(interval) {
            // Amber's "extremely low" can still be well above what solar costs, so only flash when it's free
            return interval.priceCents <= 0
        },
        ratingClasses(interval) {
            const rating = this.rating(interval);
            return rating === "green" && this.isSuperCheap(interval) ? ["green", "superCheap"] : [rating]
        },
        formatDurationFromNow(dateTime) {
            const totalMinutes = Math.max(0, Math.round(dateTime.diff(this.dateTimeNow, 'minutes').minutes));
            const hours = Math.floor(totalMinutes / 60);
            const minutes = totalMinutes % 60;
            if (hours === 0) return `in ${minutes} min`;
            return minutes === 0 ? `in ${hours} h` : `in ${hours} h ${minutes} min`;
        },
        onDashboardTap() {
            // Any tap on the dashboard puts it back into full screen (e.g. after the tablet restarted)
            if (!this.isFullscreen) {
                this.enterFullscreen();
            }
            this.requestWakeLock();
        },
        enterFullscreen() {
            const el = document.documentElement;
            const request = el.requestFullscreen || el.webkitRequestFullscreen;
            if (request) {
                Promise.resolve(request.call(el, {navigationUI: "hide"}))
                    .catch(e => console.log("Could not enter full screen", e));
            }
            this.requestWakeLock();
        },
        inBrowserFullscreen() {
            return !!(document.fullscreenElement || document.webkitFullscreenElement);
        },
        updateFullscreenState() {
            this.isFullscreen = this.inBrowserFullscreen()
                || !!(window.matchMedia && window.matchMedia("(display-mode: fullscreen)").matches);
        },
        async requestWakeLock() {
            // Keeps the screen on. Only available over HTTPS (or localhost) - otherwise use the
            // tablet's "Stay awake while charging" developer option instead.
            if (!("wakeLock" in navigator) || this.wakeLock || document.visibilityState !== "visible") {
                return;
            }
            try {
                this.wakeLock = await navigator.wakeLock.request("screen");
                this.wakeLock.addEventListener("release", () => this.wakeLock = null);
            } catch (e) {
                console.log("Could not get screen wake lock", e);
            }
        },
        handleVisibilityChange() {
            if (document.visibilityState === "visible") {
                this.requestWakeLock();
            }
        },
        heightPercentForBar(interval) {
            const price = interval.priceCents;
            if (price < 0) {
                return Math.min(this.maxNegativeBarPrice, Math.abs(price))
                    / this.maxNegativeBarPrice * (1 - this.positiveBarSpaceRatio);
            }
            let positiveBarRatio = 0;
            if (price > BAR_THRESHOLD_4) {
                positiveBarRatio = 1.0;
            } else if (price > BAR_THRESHOLD_3) {
                positiveBarRatio = 0.75 + (0.25 * ((price - BAR_THRESHOLD_3) / (BAR_THRESHOLD_4 - BAR_THRESHOLD_3)));
            } else if (price > BAR_THRESHOLD_2) {
                positiveBarRatio = 0.50 + (0.25 * ((price - BAR_THRESHOLD_2) / (BAR_THRESHOLD_3 - BAR_THRESHOLD_2)));
            } else if (price > BAR_THRESHOLD_1) {
                positiveBarRatio = 0.25 + (0.25 * ((price - BAR_THRESHOLD_1) / (BAR_THRESHOLD_2 - BAR_THRESHOLD_1)));
            } else {
                positiveBarRatio = (0.25 * price / BAR_THRESHOLD_1);
            }
            return positiveBarRatio * this.positiveBarSpaceRatio;
        },

        handleResize() {
            this.width = window.innerWidth
            this.height = window.innerHeight
        },

        showTime(interval) {
            const minute = interval.startDateTimeLocal.minute
            if (interval.duration !== 30) {
                return minute % 30 === 0
            }
            const hour = interval.startDateTimeLocal.hour
            return this.showOddTimes ? minute === 0 : (minute === 0 && (hour % 2 === 0))
        }
    },
    watch: {
        hoursForecastToShow(newValue) {
            localStorage.setItem("hoursForecastToShow", newValue);
        },
        highPriceLimit(newValue) {
            localStorage.setItem("highPriceLimit", newValue);
        },
        greenMaxCents(newValue) {
            localStorage.setItem("greenMaxCents", newValue);
        },
        redMinCents(newValue) {
            localStorage.setItem("redMinCents", newValue);
        },
        playAlerts(newValue) {
            localStorage.setItem("playAlerts", newValue);
        },
        dateTimeNow(newValue) {
            const currentHourMinute = newValue.set({seconds: 0, milliseconds: 0});
            if (currentHourMinute.toISO() !== this.hourMinuteNow.toISO()) {
                this.hourMinuteNow = currentHourMinute;
            }
        }
    },
    async mounted() {
        window.addEventListener('resize', this.handleResize);
        document.addEventListener('fullscreenchange', this.updateFullscreenState);
        document.addEventListener('webkitfullscreenchange', this.updateFullscreenState);
        document.addEventListener('visibilitychange', this.handleVisibilityChange);
        this.updateFullscreenState();
        this.handleResize();
        this.hoursForecastToShow = Number(localStorage.getItem("hoursForecastToShow")) || DEFAULT_HOURS_FORECAST_TO_SHOW;
        this.highPriceLimit = Number(localStorage.getItem("highPriceLimit")) || DEFAULT_HIGH_PRICE_LIMIT;
        const optionalCents = key => {
            const stored = localStorage.getItem(key);
            return stored === null || stored === "" || isNaN(Number(stored)) ? "" : Number(stored);
        };
        this.greenMaxCents = optionalCents("greenMaxCents");
        this.redMinCents = optionalCents("redMinCents");
        if (localStorage.getItem("playAlerts") === "false" || localStorage.getItem("playAlerts") === false
            || localStorage.getItem("silent") === "true" || localStorage.getItem("silent") === true) { // Migrating old 'silent' values
            this.playAlerts = false  // watcher will store this
        }
        // Older versions kept the Amber API key in the browser. It now lives only on the server,
        // so wipe any copy left on the device.
        ["apiKey", "selectedSiteId"].forEach(key => localStorage.removeItem(key));
        this.requestWakeLock();
        await this.maybeLoadIntervals();
        setInterval(this.maybeLoadIntervals, 1000);
        this.initialising = false
    },
    beforeDestroy() {
        window.removeEventListener('resize', this.handleResize);
        document.removeEventListener('fullscreenchange', this.updateFullscreenState);
        document.removeEventListener('webkitfullscreenchange', this.updateFullscreenState);
        document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    }
});

if ("serviceWorker" in navigator && !TEST_MODE) {
    navigator.serviceWorker.register("sw.js")
        .catch(e => console.log("Service worker registration failed", e));
}
