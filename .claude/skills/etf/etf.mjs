#!/usr/bin/env node
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const FUNDS = {
	DFEU: {
		symbol: 'DFEU.AS',
		name: 'iShares Europe Defence UCITS ETF',
		isin: 'IE000IAXNM41',
		portfolioId: 343289,
	},
	SEC0: {
		symbol: 'SEC0.DE',
		name: 'iShares MSCI Global Semiconductors UCITS ETF',
		isin: 'IE000I8KRLL9',
		portfolioId: 319084,
	},
};

const USER_AGENT =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const YAHOO_HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
const HOLDINGS_URL =
	'https://www.blackrock.com/varnish-api/uk-retail01-product-data/product-data/api/v1/get-fund-document?appType=PRODUCT_PAGE&appSubType=ISHARES&targetSite=ishares-uk&locale=en_GB&userType=individual&component=holdings';
const HOLDINGS_DIR =
	process.env.ETF_HOLDINGS_DIR ??
	join(process.env.DATA_DIR ?? '/data', 'etf', 'holdings');
const FETCH_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2000;
const DAY_MS = 86_400_000;
const MIN_PREVIOUS_SNAPSHOT_AGE_DAYS = 5;
const BACKFILL_MAX_LOOKBACK_DAYS = 12;
const WEIGHT_CHANGE_THRESHOLD_PP = 0.2;
const REBALANCE_SHARE_DEVIATION = 0.02;
const REBALANCE_MIN_WEIGHT_PCT = 0.25;
const SPLIT_FACTORS = [1.5, 2, 3, 4, 5, 8, 10, 20, 25, 50];
const SPLIT_TOLERANCE = 0.015;
const LIST_LIMIT = 8;
const MOVERS_LIMIT = 6;
const MONTHS = {
	jan: 1,
	feb: 2,
	mar: 3,
	apr: 4,
	may: 5,
	jun: 6,
	jul: 7,
	aug: 8,
	sep: 9,
	sept: 9,
	oct: 10,
	nov: 11,
	dec: 12,
};

const USAGE = `Usage: node etf.mjs <command> [--fund DFEU|SEC0] [--date YYYY-MM-DD] [--dry-run]

Commands:
  weekly     prices + holdings for each fund (default: all funds)
  prices     Friday close vs prior Friday close from the Yahoo chart API
  holdings   save a holdings snapshot and diff it against last week's`;

await main();

async function main() {
	const [command, ...rest] = process.argv.slice(2);
	const args = parseArgs(rest);
	const fundKeys = args.fund ? [args.fund.toUpperCase()] : Object.keys(FUNDS);

	for (const key of fundKeys) {
		if (!FUNDS[key])
			fail(`Unknown fund "${key}". Known: ${Object.keys(FUNDS).join(', ')}`);
	}

	const handlers = {
		weekly: async (key) => ({
			prices: await settle(() => getWeeklyPrices(key, args.date)),
			holdings: await settle(() => getHoldingsReport(key, args)),
		}),
		prices: (key) => settle(() => getWeeklyPrices(key, args.date)),
		holdings: (key) => settle(() => getHoldingsReport(key, args)),
	};

	const handler = handlers[command];

	if (!handler) fail(USAGE);

	const report = {};

	for (const key of fundKeys) {
		report[key] = {
			symbol: FUNDS[key].symbol,
			name: FUNDS[key].name,
			...(await handler(key)),
		};
	}

	console.log(JSON.stringify(report, null, 2));
}

async function getWeeklyPrices(fundKey, dateOverride) {
	const { symbol } = FUNDS[fundKey];
	const chart = await fetchYahooChart(symbol);
	const { meta } = chart;
	const timeZone = meta.exchangeTimezoneName;
	const closes = chart.indicators.quote[0].close;
	const bars = chart.timestamp
		.map((timestamp, index) => ({
			date: formatLocalDate(timestamp * 1000, timeZone),
			close: closes[index],
		}))
		.filter((bar) => bar.close != null);

	const today = formatLocalDate(Date.now(), timeZone);
	const friday = lastFridayOnOrBefore(dateOverride ?? today);
	const priorFriday = shiftDate(friday, -7);
	const weekBar = bars.findLast(
		(bar) => bar.date <= friday && bar.date > priorFriday,
	);
	const priorBar = bars.findLast((bar) => bar.date <= priorFriday);

	if (!weekBar || !priorBar) {
		throw new Error(`Missing daily bars for ${symbol} around ${friday}`);
	}

	const warnings = [];
	const regularEndSecondsOfDay = secondsOfDay(
		meta.currentTradingPeriod.regular.end,
		meta.gmtoffset,
	);
	const isLatestBar = weekBar === bars.at(-1);
	const sessionEndMs =
		(Date.parse(`${weekBar.date}T00:00:00Z`) / 1000 +
			regularEndSecondsOfDay -
			meta.gmtoffset) *
		1000;
	const lastQuoteMs = meta.regularMarketTime * 1000;
	const isFinal = !isLatestBar || lastQuoteMs >= sessionEndMs;
	const closeTimeMs = isLatestBar ? lastQuoteMs : sessionEndMs;

	if (weekBar.date !== friday) {
		warnings.push(
			`No ${symbol} session on ${friday} (holiday?) – using ${weekBar.date}.`,
		);
	}

	if (priorBar.date !== priorFriday) {
		warnings.push(
			`No ${symbol} session on ${priorFriday} – prior close is from ${priorBar.date}.`,
		);
	}

	if (!isFinal) {
		warnings.push(
			`Official ${weekBar.date} close not published yet: last quote at ${formatLocalTime(lastQuoteMs, timeZone)}, before the ${formatLocalTime(sessionEndMs, timeZone)} close. Treat as provisional.`,
		);
	}

	return {
		currency: meta.currency,
		exchange: meta.fullExchangeName,
		close: {
			date: weekBar.date,
			price: round(weekBar.close, 3),
			time: formatLocalTime(closeTimeMs, timeZone),
			final: isFinal,
		},
		priorClose: { date: priorBar.date, price: round(priorBar.close, 3) },
		changePct: round((weekBar.close / priorBar.close - 1) * 100, 2),
		week: bars
			.filter((bar) => bar.date > priorFriday && bar.date <= weekBar.date)
			.map((bar) => ({ date: bar.date, close: round(bar.close, 3) })),
		warnings,
	};
}

async function getHoldingsReport(fundKey, { date, 'dry-run': isDryRun }) {
	const { portfolioId } = FUNDS[fundKey];
	const fundDir = join(HOLDINGS_DIR, fundKey);
	const requestedDate = date ? compactDate(date) : undefined;
	const currentCsv = await fetchHoldingsCsv(portfolioId, requestedDate);
	const current = parseHoldingsCsv(currentCsv);

	if (!current.asOf)
		throw new Error(`No holdings published for ${fundKey} on ${date}`);

	const savedPaths = [];

	if (!isDryRun) {
		await mkdir(fundDir, { recursive: true });
		savedPaths.push(await saveSnapshot(fundDir, current.asOf, currentCsv));
	}

	const previous = await loadPreviousSnapshot(
		fundDir,
		current.asOf,
		portfolioId,
		isDryRun,
		savedPaths,
	);

	return {
		asOf: current.asOf,
		previousAsOf: previous?.asOf ?? null,
		saved: savedPaths,
		topHoldings: equityHoldings(current)
			.slice(0, 10)
			.map((holding) => ({ name: holding.name, weight: holding.weight })),
		...(previous
			? diffHoldings(previous, current)
			: { note: 'No previous snapshot to diff against.' }),
	};
}

async function loadPreviousSnapshot(
	fundDir,
	asOf,
	portfolioId,
	isDryRun,
	savedPaths,
) {
	const cutoff = shiftDate(asOf, -MIN_PREVIOUS_SNAPSHOT_AGE_DAYS);
	const files = await readdir(fundDir).catch(() => []);
	const previousFile = files
		.filter(
			(file) =>
				/^\d{4}-\d{2}-\d{2}\.csv$/.test(file) && file.slice(0, 10) <= cutoff,
		)
		.sort()
		.at(-1);

	if (
		previousFile &&
		previousFile.slice(0, 10) >= shiftDate(asOf, -BACKFILL_MAX_LOOKBACK_DAYS)
	) {
		return parseHoldingsCsv(
			await readFile(join(fundDir, previousFile), 'utf8'),
		);
	}

	for (let daysBack = 7; daysBack <= BACKFILL_MAX_LOOKBACK_DAYS; daysBack++) {
		const csv = await fetchHoldingsCsv(
			portfolioId,
			compactDate(shiftDate(asOf, -daysBack)),
		);
		const snapshot = parseHoldingsCsv(csv);

		if (!snapshot.asOf) continue;

		if (!isDryRun)
			savedPaths.push(await saveSnapshot(fundDir, snapshot.asOf, csv));

		return snapshot;
	}

	return null;
}

async function saveSnapshot(fundDir, asOf, csv) {
	const path = join(fundDir, `${asOf}.csv`);
	await writeFile(path, csv);
	return path;
}

function diffHoldings(previous, current) {
	const previousByKey = new Map(
		equityHoldings(previous).map((holding) => [holding.key, holding]),
	);
	const currentByKey = new Map(
		equityHoldings(current).map((holding) => [holding.key, holding]),
	);
	const common = [...currentByKey.values()]
		.filter((holding) => previousByKey.has(holding.key))
		.map((holding) => ({
			now: holding,
			before: previousByKey.get(holding.key),
		}));

	const fundFlowRatio = median(
		common
			.filter(({ now, before }) => now.shares > 0 && before.shares > 0)
			.map(({ now, before }) => now.shares / before.shares),
	);
	const tracked = common
		.filter(
			({ now, before }) => now.shares > 0 && before.shares > 0 && fundFlowRatio,
		)
		.map(({ now, before }) => {
			const sharesVsFundFlow = now.shares / before.shares / fundFlowRatio;
			const splitFactor = detectSplitFactor(sharesVsFundFlow);
			const perShareRatio =
				now.marketValue / now.shares / (before.marketValue / before.shares);
			return {
				now,
				before,
				splitFactor,
				sharesDeviationPct: (sharesVsFundFlow / splitFactor - 1) * 100,
				movePct: (perShareRatio * splitFactor - 1) * 100,
			};
		});

	return {
		entries: [...currentByKey.values()]
			.filter((holding) => !previousByKey.has(holding.key))
			.slice(0, LIST_LIMIT)
			.map((holding) => ({ name: holding.name, weight: holding.weight })),
		exits: [...previousByKey.values()]
			.filter((holding) => !currentByKey.has(holding.key))
			.slice(0, LIST_LIMIT)
			.map((holding) => ({
				name: holding.name,
				previousWeight: holding.weight,
			})),
		weightChanges: common
			.map(({ now, before }) => ({
				name: now.name,
				weight: now.weight,
				changePp: round(now.weight - before.weight, 2),
			}))
			.filter(
				(change) => Math.abs(change.changePp) >= WEIGHT_CHANGE_THRESHOLD_PP,
			)
			.sort(
				(first, second) => Math.abs(second.changePp) - Math.abs(first.changePp),
			)
			.slice(0, LIST_LIMIT),
		rebalanced: tracked
			.filter(
				(item) =>
					Math.abs(item.sharesDeviationPct) >=
						REBALANCE_SHARE_DEVIATION * 100 &&
					Math.max(item.now.weight, item.before.weight) >=
						REBALANCE_MIN_WEIGHT_PCT,
			)
			.sort(
				(first, second) =>
					Math.abs(second.sharesDeviationPct) -
					Math.abs(first.sharesDeviationPct),
			)
			.slice(0, LIST_LIMIT)
			.map((item) => ({
				name: item.now.name,
				weight: item.now.weight,
				sharesVsFundFlowPct: round(item.sharesDeviationPct, 1),
			})),
		splits: tracked
			.filter((item) => item.splitFactor !== 1)
			.map((item) => ({
				name: item.now.name,
				factor: round(item.splitFactor, 3),
			})),
		fundSharesChangePct: fundFlowRatio
			? round((fundFlowRatio - 1) * 100, 2)
			: null,
		movers: tracked
			.map((item) => ({
				name: item.now.name,
				ticker: item.now.ticker,
				exchange: item.now.exchange,
				weight: item.before.weight,
				movePct: round(item.movePct, 1),
				contributionPp: round((item.before.weight * item.movePct) / 100, 2),
			}))
			.sort(
				(first, second) =>
					Math.abs(second.contributionPp) - Math.abs(first.contributionPp),
			)
			.slice(0, MOVERS_LIMIT),
	};
}

function detectSplitFactor(sharesVsFundFlow) {
	const candidates = SPLIT_FACTORS.flatMap((factor) => [factor, 1 / factor]);
	return (
		candidates.find(
			(factor) => Math.abs(sharesVsFundFlow / factor - 1) <= SPLIT_TOLERANCE,
		) ?? 1
	);
}

function equityHoldings(snapshot) {
	return snapshot.holdings
		.filter((holding) => holding.assetClass === 'Equity')
		.sort((first, second) => second.weight - first.weight);
}

function parseHoldingsCsv(csv) {
	const lines = csv.split(/\r?\n/);
	const asOfMatch = lines[0]?.match(/"(\d{1,2})\/([A-Za-z]+)\/(\d{4})"/);
	const asOf = asOfMatch ? toIsoDate(asOfMatch) : null;
	const headerIndex = lines.findIndex((line) => line.startsWith('Ticker,'));

	if (!asOf || headerIndex === -1) return { asOf: null, holdings: [] };

	const header = parseCsvLine(lines[headerIndex]);
	const column = (name) => header.indexOf(name);
	const holdings = [];

	for (const line of lines.slice(headerIndex + 1)) {
		if (!line.trim()) break;

		const cells = parseCsvLine(line);

		if (cells.length < header.length) continue;

		const ticker = cells[column('Ticker')];
		const exchange = cells[column('Exchange')];

		holdings.push({
			key: `${ticker}|${exchange}`,
			ticker,
			name: cells[column('Name')],
			assetClass: cells[column('Asset Class')],
			exchange,
			weight: parseNumber(cells[column('Weight (%)')]) ?? 0,
			marketValue: parseNumber(cells[column('Market Value')]) ?? 0,
			shares: parseNumber(cells[column('Shares')]) ?? 0,
		});
	}

	return { asOf, holdings };
}

function parseCsvLine(line) {
	const cells = [];
	let cell = '';
	let isQuoted = false;

	for (let index = 0; index < line.length; index++) {
		const character = line[index];

		if (isQuoted) {
			if (character === '"' && line[index + 1] === '"') {
				cell += '"';
				index++;
			} else if (character === '"') {
				isQuoted = false;
			} else {
				cell += character;
			}
		} else if (character === '"') {
			isQuoted = true;
		} else if (character === ',') {
			cells.push(cell);
			cell = '';
		} else {
			cell += character;
		}
	}

	cells.push(cell);
	return cells;
}

async function fetchYahooChart(symbol) {
	const errors = [];

	for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt++) {
		for (const host of YAHOO_HOSTS) {
			const url = `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?range=1mo&interval=1d`;

			try {
				const body = JSON.parse(await fetchText(url));
				const result = body.chart?.result?.[0];

				if (result?.timestamp?.length) return result;

				errors.push(
					`${host}: ${body.chart?.error?.description ?? 'empty result'}`,
				);
			} catch (error) {
				errors.push(`${host}: ${error.message}`);
			}
		}

		await sleep(RETRY_DELAY_MS * (attempt + 1));
	}

	throw new Error(`Yahoo chart failed for ${symbol} – ${errors.join('; ')}`);
}

async function fetchHoldingsCsv(portfolioId, compactAsOfDate) {
	const url = `${HOLDINGS_URL}&portfolioId=${portfolioId}${compactAsOfDate ? `&asOfDate=${compactAsOfDate}` : ''}`;
	let lastError;

	for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt++) {
		try {
			return await fetchText(url);
		} catch (error) {
			lastError = error;
			await sleep(RETRY_DELAY_MS * (attempt + 1));
		}
	}

	throw new Error(`iShares holdings download failed – ${lastError.message}`);
}

async function fetchText(url) {
	const response = await fetch(url, {
		headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
		signal: AbortSignal.timeout(20_000),
	});

	if (!response.ok) throw new Error(`HTTP ${response.status}`);

	return response.text();
}

async function settle(task) {
	try {
		return await task();
	} catch (error) {
		return { error: error.message };
	}
}

function parseArgs(argv) {
	const args = {};

	for (let index = 0; index < argv.length; index++) {
		if (!argv[index].startsWith('--')) continue;

		const key = argv[index].slice(2);
		const next = argv[index + 1];

		if (next && !next.startsWith('--')) {
			args[key] = next;
			index++;
		} else {
			args[key] = true;
		}
	}

	return args;
}

function lastFridayOnOrBefore(isoDate) {
	const dayOfWeek = new Date(`${isoDate}T00:00:00Z`).getUTCDay();
	return shiftDate(isoDate, -((dayOfWeek + 2) % 7));
}

function shiftDate(isoDate, days) {
	return new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * DAY_MS)
		.toISOString()
		.slice(0, 10);
}

function compactDate(isoDate) {
	return isoDate.replaceAll('-', '');
}

function toIsoDate([, day, monthName, year]) {
	const month = MONTHS[monthName.toLowerCase()];
	return month
		? `${year}-${String(month).padStart(2, '0')}-${day.padStart(2, '0')}`
		: null;
}

function formatLocalDate(epochMs, timeZone) {
	return new Intl.DateTimeFormat('en-CA', { timeZone }).format(epochMs);
}

function formatLocalTime(epochMs, timeZone) {
	return new Intl.DateTimeFormat('sv-SE', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		timeZoneName: 'short',
	}).format(epochMs);
}

function secondsOfDay(epochSeconds, gmtOffsetSeconds) {
	return (((epochSeconds + gmtOffsetSeconds) % 86_400) + 86_400) % 86_400;
}

function parseNumber(value) {
	const number = Number.parseFloat(String(value).replaceAll(',', ''));
	return Number.isFinite(number) ? number : null;
}

function median(values) {
	if (!values.length) return null;

	const sorted = [...values].sort((first, second) => first - second);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2
		? sorted[middle]
		: (sorted[middle - 1] + sorted[middle]) / 2;
}

function round(value, digits) {
	return Number(value.toFixed(digits));
}

function sleep(durationMs) {
	return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function fail(message) {
	console.error(message);
	process.exit(1);
}
