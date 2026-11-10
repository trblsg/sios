#!/usr/bin/env node
/*
 * analyze-max77705-log.mjs: read a HakiOS kernel log (the USB console, `log` at the console, dmesg, or
 * /proc/last_kmsg after a run) and say what the MAX77705 charger and gauge did.
 *
 * It reads only the log; nothing here talks to the phone. It is for the question "the phone is hot and the
 * charging current fell from 0.88 A to 0.47 A: is that the charger, the cable, the input limit, the battery's
 * CV taper, or the system load?".
 *
 * Build a log with (only max77705_wdt writes the charger, and only CNFG_06; the rest is read-only):
 *
 *   max77705_wdt=1 max77705_diag=1 max77705_fg_s=30 tmu=3 fps_log=1
 *
 * and, when comparing heat, gov_policy=2 cpufreq_gov_big_max=1469000 mali_gov_frame=455.  When the screen is
 * meant to be off, add panel_sleep=1 sleep_cores=1.  gov_policy=3 is not a heat switch: docs/heat.md explains
 * why it can run hotter.  See docs/power-charging.md.
 *
 * Usage:
 *
 *   node tools/analyze-max77705-log.mjs max77705.log
 *   node tools/analyze-max77705-log.mjs --csv samples.csv max77705.log
 *   node tools/analyze-max77705-log.mjs --json report.json max77705.log
 *   node tools/analyze-max77705-log.mjs --self-test
 *
 * Exit status: 0 with a report, 2 when no max77705 line was found, 1 on a bad invocation or a failed
 * self-test. Standard library only (Node 18 or later).
 */

import { readFileSync, writeFileSync } from 'node:fs';

const POLL_S = 5;                       /* the battery thread's poll, hakios.max77705.c POLL_MS */
const STATE_EVERY_S = 5 * 60;           /* its "every 5 minutes" line */
const WDT_KICK_S = 30;                  /* max77705_wdt=1: WDT_KICK_POLLS * POLL_MS */
const ANDROID_CHG_HIGH_C = 46;          /* battery,chg_high_temp in the S9's device tree */
const ANDROID_TEMP_HIGH_C = 50;         /* battery,temp_high_threshold_event */
const ANDROID_TMU_STOP_C = 60;          /* tmu_batt_stop */

/* ------------------------------------------------------------------------------------------------------------------ */
/* the log lines                                                                                                      */

function parseNumber(text) {
	if (text == null) {
		return null;
	}
	text = String(text).trim();
	if (text === '' || text === '?' || text === '--' || text === '-1') {
		return null;
	}
	if (/^0x[0-9a-f]+$/i.test(text)) {
		return parseInt(text.slice(2), 16);
	}
	const n = Number(text);
	return Number.isFinite(n) ? n : null;
}

/* the input limit's code in CNFG_09 (Samsung max77705_get_input_current_type) */
function inputLimitMa(code) {
	if (code == null || code < 0) {
		return null;
	}
	code &= 0x7f;
	if (code <= 0x03) {
		return 100;
	}
	if (code >= 0x7f) {
		return 3200;
	}
	return (code + 1) * 25;
}

/* the fast-charge current's code in CNFG_02 (Samsung max77705_get_charge_current) */
function fastChargeMa(code) {
	if (code == null || code < 0) {
		return null;
	}
	code &= 0x3f;
	return code <= 0x02 ? 100 : code * 50;
}

const STATUS = {
	charging: 'charging',
	full: 'full',
	'on a charger, not charging': 'stopped',
	discharging: 'discharging'
};

const STATE_RE = new RegExp(
	'^max77705:\\s+(.+?):\\s+(-?\\d+)\\.(\\d+)%,\\s+(-?\\d+)\\s+mV,\\s+(-?\\d+)\\s+mA,\\s+' +
	'(-?\\d+)\\.(\\d+)\\s+C\\s+\\(ADC\\s+(-?\\d+)\\),\\s+(a battery|NO BATTERY),\\s+' +
	'(charging|full|on a charger, not charging|discharging),\\s+(\\d+)\\s+of\\s+(\\d+)\\s+mAh\\s+' +
	'\\(full\\s+(\\d+)\\),\\s+(\\d+)\\s+cycles'
);

const DIAG_RAW_RE = /^max77705:\s+charger\s+(.+?):\s+0xb2-0xc5:(.*)$/;
const DIAG_SAY_RE = new RegExp(
	'^max77705:\\s+charger\\s+(.+?):\\s+CNFG_00 mode\\s+(\\S+)\\s+WDTEN\\s+(-?\\d+);\\s+' +
	'CHGIN_DTLS\\s+(-?\\d+);\\s+CHG_DTLS\\s+(\\S+)\\s+BAT_DTLS\\s+(-?\\d+);\\s+BYP_DTLS\\s+(\\S+);\\s+' +
	'fast charge\\s+(-?\\d+)\\s+mA;\\s+input limit code\\s+(\\S+)\\s+\\(CNFG_09\\)'
);

const FG_RE = new RegExp(
	'^max77705:\\s+fg:\\s+t\\s+(\\d+)\\s+s,\\s+(\\d+)\\.(\\d+)%,\\s+(\\d+)\\s+mAh,\\s+' +
	'current\\s+(-?\\d+)\\s+mA,\\s+avg\\s+(-?\\d+)\\s+mA,\\s+QH\\s+(\\d+)'
);

const CPU_RE = new RegExp(
	'^cpufreq_gov:\\s+(\\d+)\\s+s:\\s+lit\\s+(\\d+)\\s+MHz\\S*\\s+load\\s+(\\d+)%\\s+\\([^)]*\\)\\s+\\|\\s+' +
	'big\\s+(\\d+)\\s+MHz\\S*\\s+load\\s+(\\d+)%\\s+\\([^)]*\\)\\s+\\|\\s+temp big\\s+(\\S+)\\s+lit\\s+(\\S+)\\s+C'
);

/* fps_log=1, MiniIOMobileFramebuffer.cpp fpsLine(): one line a second while frames come */
const FPS_RE = new RegExp(
	'^fps:\\s+(\\d+)\\s+refreshes missed while moving,\\s+the longest gap\\s+(\\d+)\\.(\\d+)\\s+ms;\\s+' +
	'zc:\\s+(\\d+)\\s+in place,\\s+(\\d+)\\s+copied,\\s+(\\d+)\\s+into the one shown;\\s+' +
	'gpu:\\s+(none;\\s+)?(\\d+)%\\s+busy,\\s+(\\d+)\\s+us a frame shown,\\s+(\\d+)\\s+jobs\\s+' +
	'\\((\\d+)\\s+us each,\\s+(\\d+)\\s+us queued\\),\\s+(\\d+)\\s+MHz(\\s+\\(mali_gov\\))?,\\s+' +
	'(\\d+)\\s+switches,\\s+G3D\\s+(-?\\d+)\\s+C'
);

/* hakios.mali.c, every 5 s */
const MALI_BUSY_RE = new RegExp(
	'^mali:\\s+GPU busy\\s+(\\d+)%\\s+of\\s+(\\d+)\\s+s:\\s+vertex and tiler\\s+(\\d+)\\s+jobs\\s+' +
	'(\\d+)\\s+ms\\s+\\((\\d+)\\s+us each\\),\\s+fragment\\s+(\\d+)\\s+jobs\\s+(\\d+)\\s+ms\\s+\\((\\d+)\\s+us each\\)'
);

/* hakios.exynos_cpufreq.c, one line per ceiling change */
const COOL_RE = /^cpufreq_gov:\s+(big|lit) at\s+(-?\d+)\.(\d+)\s+C:\s+its ceiling\s+(now|back to)\s+(\d+)\s+kHz/;

/* hakios.mali.c, one line per G3D cap change */
const MALI_CAP_RE = /^mali:\s+mali_gov:\s+the G3D at\s+(-?\d+)\.(\d+)\s+C:\s+(\d+)\s+MHz at most now/;

/* hakios.exynos_tmu.c, every tmu_log seconds or on a 5 C step */
const TMU_RE = /^tmu:\s+(\d+)\s+sensors read;\s+hottest\s+(big|little|g3d|isp)\s+at\s+(-?\d+)\.(\d+)\s+C;/;

const RAW_REGS = Array.from({ length: 20 }, (_, i) => 0xb2 + i);   /* 0xB2..0xC5 */

function stripPrefix(line) {
	/* dmesg: "[   12.345678] max77705: ..."; the USB console usually has no time */
	const m = line.match(/^\s*\[\s*(\d+(?:\.\d+)?)\]\s*(.*)$/);
	if (m) {
		return { t: Number(m[1]), body: m[2] };
	}
	return { t: null, body: line };
}

function parseLog(text) {
	const lines = text.split(/\r?\n/);
	const states = [];
	const diags = [];
	const fgs = [];
	const cpus = [];
	const gpus = [];
	const maliBusy = [];
	const tmuLines = [];
	const cools = [];
	const events = [];
	const wdt = { started: false, kicked: 0, failed: 0, skipped: 0, summaries: [] };
	let max77705Lines = 0;
	let firstT = null;
	let lastT = null;

	for (let lineNo = 1; lineNo <= lines.length; lineNo++) {
		const { t, body } = stripPrefix(lines[lineNo - 1]);
		if (t != null) {
			firstT = firstT == null ? t : firstT;
			lastT = t;
		}
		const at = body.indexOf('max77705:');
		if (at < 0) {
			const cpu = body.match(CPU_RE);
			if (cpu) {
				cpus.push({
					lineNo,
					t,
					s: Number(cpu[1]),
					litMhz: Number(cpu[2]),
					litLoad: Number(cpu[3]),
					bigMhz: Number(cpu[4]),
					bigLoad: Number(cpu[5]),
					tempBigC: parseNumber(cpu[6]),
					tempLitC: parseNumber(cpu[7])
				});
			}
			const fps = body.match(FPS_RE);
			if (fps) {
				gpus.push({
					lineNo,
					t,
					missed: Number(fps[1]),
					gapMs: Number(`${fps[2]}.${fps[3]}`),
					zcInPlace: Number(fps[4]),
					zcCopied: Number(fps[5]),
					zcShown: Number(fps[6]),
					none: Boolean(fps[7]),
					busyPct: Number(fps[8]),
					usPerFrame: Number(fps[9]),
					jobs: Number(fps[10]),
					usPerJob: Number(fps[11]),
					usQueuedPerJob: Number(fps[12]),
					mhz: Number(fps[13]),
					maliGov: Boolean(fps[14]),
					switches: Number(fps[15]),
					g3dC: Number(fps[16])
				});
			}
			const busy = body.match(MALI_BUSY_RE);
			if (busy) {
				maliBusy.push({
					lineNo,
					t,
					busyPct: Number(busy[1]),
					seconds: Number(busy[2]),
					vertexJobs: Number(busy[3]),
					vertexMs: Number(busy[4]),
					vertexUs: Number(busy[5]),
					fragmentJobs: Number(busy[6]),
					fragmentMs: Number(busy[7]),
					fragmentUs: Number(busy[8])
				});
			}
			const cool = body.match(COOL_RE);
			if (cool) {
				cools.push({
					kind: 'cpu',
					lineNo,
					t,
					cluster: cool[1],
					tempC: Number(`${cool[2]}.${cool[3]}`),
					action: cool[4],
					khz: Number(cool[5])
				});
			}
			const cap = body.match(MALI_CAP_RE);
			if (cap) {
				cools.push({
					kind: 'gpu',
					lineNo,
					t,
					tempC: Number(`${cap[1]}.${cap[2]}`),
					capMhz: Number(cap[3])
				});
			}
			const tmuLine = body.match(TMU_RE);
			if (tmuLine) {
				const zones = {};
				const zoneRe = /(big|little|g3d|isp)\d+=(-?\d+)\.(\d+)/g;
				let zone;
				while ((zone = zoneRe.exec(body)) !== null) {
					const mc = Number(`${zone[2]}.${zone[3]}`);
					zones[zone[1]] = zones[zone[1]] == null ? mc : Math.max(zones[zone[1]], mc);
				}
				tmuLines.push({
					lineNo,
					t,
					sensors: Number(tmuLine[1]),
					hottest: tmuLine[2],
					hottestC: Number(`${tmuLine[3]}.${tmuLine[4]}`),
					zones
				});
			}
			if (/GenericARMPE: the display (off|on)/.test(body)) {
				events.push({ kind: 'display', lineNo, t, on: /the display on/.test(body), text: body.trim() });
			} else if (/s6e3ha8: panel_sleep:/.test(body)) {
				events.push({ kind: 'panel', lineNo, t, on: /screen on/.test(body), text: body.trim() });
			} else if (/GenericARMPE: sleep_cores: cpu \d+ (taken off|started again)/.test(body)) {
				events.push({ kind: 'cores', lineNo, t, text: body.trim() });
			} else if (/exynos_camera: 5: STREAM ON/.test(body)) {
				events.push({ kind: 'camera-on', lineNo, t, text: body.trim() });
			} else if (/exynos_camera: the sensor told to stop streaming/.test(body)) {
				events.push({ kind: 'camera-off', lineNo, t, text: body.trim() });
			}
			continue;
		}

		const msg = body.slice(at);
		max77705Lines++;

		let m = msg.match(STATE_RE);
		if (m) {
			states.push({
				lineNo,
				t,
				when: m[1],
				pct: Number(`${m[2]}.${m[3]}`),
				mv: Number(m[4]),
				ma: Number(m[5]),
				tempC: Number(`${m[6]}.${m[7]}`),
				adc: Number(m[8]),
				present: m[9] === 'a battery',
				status: STATUS[m[10]] || m[10],
				statusText: m[10],
				cap: Number(m[11]),
				design: Number(m[12]),
				full: Number(m[13]),
				cycles: Number(m[14])
			});
			continue;
		}

		m = msg.match(FG_RE);
		if (m) {
			fgs.push({
				lineNo,
				t: Number(m[1]),
				pct: Number(`${m[2]}.${m[3]}`),
				cap: Number(m[4]),
				ma: Number(m[5]),
				avgMa: Number(m[6]),
				qh: Number(m[7])
			});
			continue;
		}

		m = msg.match(DIAG_RAW_RE);
		if (m) {
			const tokens = m[2].trim() === '' ? [] : m[2].trim().split(/\s+/);
			const regs = {};
			for (let i = 0; i < RAW_REGS.length; i++) {
				/* the driver prints each byte with %02x: bare hex, never a 0x prefix */
				const token = tokens[i];
				regs[RAW_REGS[i]] = token == null || token === '--' ? null : parseInt(token, 16);
			}
			diags.push({
				lineNo,
				t,
				when: m[1],
				raw: true,
				regs,
				...decodeRegs(regs)
			});
			continue;
		}

		m = msg.match(DIAG_SAY_RE);
		if (m) {
			const cnfg00 = parseNumber(m[2]);
			const cnfg02Code = null; /* this line has the decoded mA, not the code */
			const inputCode = parseNumber(m[9]);
			diags.push({
				lineNo,
				t,
				when: m[1],
				raw: false,
				regs: null,
				cnfg00,
				wdten: parseNumber(m[3]) === 1,
				chginDtls: parseNumber(m[4]),
				chgDtls: parseNumber(m[5]),
				batDtls: parseNumber(m[6]),
				bypDtls: parseNumber(m[7]),
				fastMa: parseNumber(m[8]),
				inputCode,
				inputMa: inputLimitMa(inputCode),
				cnfg02Code
			});
			continue;
		}

		if (/^max77705: wdt:/.test(msg)) {
			if (/the charger's watchdog kicked every/.test(msg)) {
				wdt.started = true;
			} else if (/: kicked \(|: FAILED/.test(msg)) {
				if (/FAILED/.test(msg)) {
					wdt.failed++;
				} else {
					wdt.kicked++;
				}
			} else if (/the watchdog is off/.test(msg)) {
				wdt.skipped++;
			}
			const sum = msg.match(/^max77705: wdt:\s+(\d+) kicks,\s+(\d+) with the watchdog off,\s+(\d+) failed/);
			if (sum) {
				wdt.summaries.push({
					lineNo,
					t,
					kicks: Number(sum[1]),
					skipped: Number(sum[2]),
					failed: Number(sum[3])
				});
			}
			continue;
		}

		if (/^max77705: usb switch|^max77705: VBUS in|^max77705: the test|^max77705: usb switch/.test(msg)) {
			events.push({ kind: 'usb', lineNo, t, text: msg.trim() });
		}
	}

	return { lines: lines.length, max77705Lines, states, diags, fgs, cpus, gpus, maliBusy, tmuLines, cools, events, wdt, firstT, lastT };
}

/* the raw 0xB2-0xC5 bytes as the driver's names, with the charger's own bit fields */
function decodeRegs(regs) {
	const r = (reg) => regs[reg] ?? null;
	const cnfg00 = r(0xb7);
	const cnfg02 = r(0xb9);
	const cnfg09 = r(0xc0);
	const details00 = r(0xb3);
	const details01 = r(0xb4);
	const details02 = r(0xb5);
	const intOk = r(0xb2);
	return {
		cnfg00,
		wdten: cnfg00 == null ? null : ((cnfg00 >> 4) & 1) === 1,
		cnfg02Code: cnfg02,
		fastMa: fastChargeMa(cnfg02),
		cnfg09Code: cnfg09,
		inputCode: cnfg09,
		inputMa: inputLimitMa(cnfg09),
		chginDtls: details00 == null ? null : (details00 >> 5) & 3,
		chgDtls: details01 == null ? null : details01 & 0x0f,
		batDtls: details01 == null ? null : (details01 >> 4) & 7,
		bypDtls: details02 == null ? null : details02 & 0x0f,
		chginOk: intOk == null ? null : ((intOk >> 6) & 1) === 1,
		wcinOk: intOk == null ? null : ((intOk >> 5) & 1) === 1
	};
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* the analysis                                                                                                       */

function average(xs) {
	const ok = xs.filter((x) => Number.isFinite(x));
	return ok.length === 0 ? null : ok.reduce((a, b) => a + b, 0) / ok.length;
}

function highest(...xs) {
	const ok = xs.filter((x) => Number.isFinite(x));
	return ok.length === 0 ? null : Math.max(...ok);
}

function firstLast(xs) {
	return xs.length === 0 ? { first: null, last: null } : { first: xs[0], last: xs[xs.length - 1] };
}

function formatMa(ma) {
	return ma == null ? '?' : `${Math.round(ma)} mA`;
}

function formatC(c) {
	return c == null ? '?' : `${c.toFixed(1)} °C`;
}

/* a register code as hex, or "?" when the line did not carry it (the decoded charger line has mA, not codes) */
function formatCode(code) {
	return code == null ? '?' : '0x' + code.toString(16);
}

function analyze(log) {
	const { states, diags, fgs, cpus, gpus, maliBusy, tmuLines, cools, events, wdt } = log;
	const findings = [];
	const add = (level, title, detail) => findings.push({ level, title, detail });

	const stateWithBattery = states.filter((s) => s.present);
	const charging = stateWithBattery.filter((s) => s.status === 'charging' || s.status === 'full');
	const stopping = stateWithBattery.filter((s) => s.status === 'stopped');
	const discharging = stateWithBattery.filter((s) => s.status === 'discharging');
	const { first: firstState, last: lastState } = firstLast(stateWithBattery);

	const temps = stateWithBattery.map((s) => s.tempC).filter(Number.isFinite);
	const maxTemp = temps.length ? Math.max(...temps) : null;
	const minTemp = temps.length ? Math.min(...temps) : null;

	const currents = charging.map((s) => s.ma).filter(Number.isFinite);
	const { first: firstCharging, last: lastCharging } = firstLast(charging);
	const currentDrop = firstCharging && lastCharging ? firstCharging.ma - lastCharging.ma : null;
	const minCurrent = currents.length ? Math.min(...currents) : null;
	const maxCurrent = currents.length ? Math.max(...currents) : null;

	/* the charger's input limit, from every 5-minute dump that has CNFG_09 */
	const limits = diags
		.filter((d) => d.inputMa != null)
		.map((d, i) => ({ i, lineNo: d.lineNo, t: d.t, code: d.inputCode, ma: d.inputMa }));
	const { first: firstLimit, last: lastLimit } = firstLast(limits);
	let peakLimit = null;
	let maxLimitDrop = 0;
	let peakAt = null;
	for (const x of limits) {
		if (peakLimit == null || x.ma > peakLimit) {
			peakLimit = x.ma;
			peakAt = x;
		}
		if (peakLimit - x.ma > maxLimitDrop) {
			maxLimitDrop = peakLimit - x.ma;
		}
	}
	const limitDrops = [];
	for (let i = 1; i < limits.length; i++) {
		const d = limits[i - 1].ma - limits[i].ma;
		if (d >= 25) {
			limitDrops.push({ from: limits[i - 1].ma, to: limits[i].ma, by: d, at: limits[i] });
		}
	}

	const fast = diags
		.filter((d) => d.fastMa != null)
		.map((d) => ({ ma: d.fastMa, code: d.cnfg02Code, lineNo: d.lineNo, t: d.t }));
	const { first: firstFast, last: lastFast } = firstLast(fast);

	const chginValid = diags.filter((d) => d.chginDtls === 3);
	const chgDtls = diags.map((d) => d.chgDtls).filter((x) => x != null);
	const stoppedWithVbus = stopping.length > 0 && chginValid.length > 0;
	const dischargingWithVbus = discharging.length > 0 && diags.some((d) => d.chginOk);

	/* the display and the cores */
	const displayOff = events.filter((e) => e.kind === 'display' && !e.on).length;
	const displayOn = events.filter((e) => e.kind === 'display' && e.on).length;
	const panelSleep = events.filter((e) => e.kind === 'panel').length;
	const coreOff = events.filter((e) => e.kind === 'cores' && /taken off/.test(e.text)).length;
	const coreOn = events.filter((e) => e.kind === 'cores' && /started again/.test(e.text)).length;
	const cameraOn = events.filter((e) => e.kind === 'camera-on').length;
	const cameraOff = events.filter((e) => e.kind === 'camera-off').length;

	/* the fps lines that arrived while the display was off, by line order: the frame thread still running */
	const displayEvents = events.filter((e) => e.kind === 'display').sort((a, b) => a.lineNo - b.lineNo);
	let displayIsOn = true;
	let displayEvent = 0;
	const fpsWhileOff = [];
	for (const g of gpus) {
		while (displayEvent < displayEvents.length && displayEvents[displayEvent].lineNo < g.lineNo) {
			displayIsOn = displayEvents[displayEvent].on;
			displayEvent++;
		}
		if (!displayIsOn) {
			fpsWhileOff.push(g);
		}
	}
	const fpsOffCount = fpsWhileOff.length;
	const fpsOffMhz = average(fpsWhileOff.filter((g) => !g.none && g.mhz > 0).map((g) => g.mhz));

	/* the CPU governor: how often the M3s sat at or near their ceiling */
	const bigMhz = cpus.map((c) => c.bigMhz).filter(Number.isFinite);
	const bigHigh = bigMhz.filter((m) => m >= 1700).length;
	const bigHighPct = bigMhz.length ? Math.round(100 * bigHigh / bigMhz.length) : null;
	const cpuTemp = cpus.map((c) => c.tempBigC).filter(Number.isFinite);
	const maxCpuTemp = cpuTemp.length ? Math.max(...cpuTemp) : null;
	const litTemp = cpus.map((c) => c.tempLitC).filter(Number.isFinite);
	const maxLitTemp = litTemp.length ? Math.max(...litTemp) : null;

	/* the GPU: the fps line has its clock, busy share and G3D sensor; mali: GPU busy has 5 s windows */
	const gpuSamples = gpus.filter((g) => !g.none && g.mhz > 0);
	const gpuBusy = gpuSamples.map((g) => g.busyPct).filter(Number.isFinite);
	const gpuAvgBusy = average(gpuBusy);
	const gpuMaxMhz = gpuSamples.length ? Math.max(...gpuSamples.map((g) => g.mhz)) : null;
	const g3dTemps = gpuSamples.map((g) => g.g3dC).filter(Number.isFinite);
	const maxG3d = g3dTemps.length ? Math.max(...g3dTemps) : null;
	const gpuFloorSamples = gpuSamples.filter((g) => g.mhz >= 455 && g.busyPct < 25).length;
	const gpuFloorPct = gpuSamples.length ? Math.round(100 * gpuFloorSamples / gpuSamples.length) : null;
	const maliBusyAvg = average(maliBusy.map((b) => b.busyPct));
	const coolBig = cools.filter((c) => c.kind === 'cpu' && c.cluster === 'big' && c.action === 'now').length;
	const coolLit = cools.filter((c) => c.kind === 'cpu' && c.cluster === 'lit' && c.action === 'now').length;
	const cap455 = cools.filter((c) => c.kind === 'gpu' && c.capMhz === 455).length;
	const cap260 = cools.filter((c) => c.kind === 'gpu' && c.capMhz === 260).length;

	/* the TMU summaries: the hottest zone and the ISP, which no other line carries */
	const tmuBig = tmuLines.map((x) => x.zones.big).filter(Number.isFinite);
	const tmuIsp = tmuLines.map((x) => x.zones.isp).filter(Number.isFinite);
	const tmuG3d = tmuLines.map((x) => x.zones.g3d).filter(Number.isFinite);
	const tmuLittle = tmuLines.map((x) => x.zones.little).filter(Number.isFinite);
	const maxTmuBig = tmuBig.length ? Math.max(...tmuBig) : null;
	const maxTmuLittle = tmuLittle.length ? Math.max(...tmuLittle) : null;
	const maxIsp = tmuIsp.length ? Math.max(...tmuIsp) : null;
	const maxTmuG3d = tmuG3d.length ? Math.max(...tmuG3d) : null;
	const maxLittle = highest(maxLitTemp, maxTmuLittle);

	/* --- the findings --- */

	if (stateWithBattery.length === 0 && diags.length === 0) {
		add('unknown', 'No max77705 line found',
			'The file has none of the lines the driver prints. Capture the USB console from the kernel\'s first line, or use `log` at the console.');
	}

	if (stateWithBattery.length > 0 && diags.length === 0) {
		add('warn', 'No charger dump: CNFG_09/CNFG_02 are unknown',
			'Add max77705_diag=1. Without it the log shows the battery current but not the input limit, so an AICL drop and a CV taper look the same.');
	}

	if (firstState && lastState) {
		const mwFirst = firstState.mv * firstState.ma / 1000;
		const mwLast = lastState.mv * lastState.ma / 1000;
		if (lastState.ma < 0) {
			add('critical', 'The battery is discharging while the log says it is on a charger',
				`${lastState.pct.toFixed(2)}% at ${lastState.mv} mV, ${lastState.ma} mA. The charger's input is below the phone's load, or the charger has stopped. See the CNFG_09/CHG_DTLS lines.`);
		}
		if (mwFirst > 0 && mwLast > 0 && mwLast < mwFirst * 0.6 && currentDrop != null && currentDrop > 150) {
			add('info', 'Net battery power fell',
				`${mwFirst.toFixed(0)} mW at the first sample, ${mwLast.toFixed(0)} mW at the last (voltage × gauge current). This is the battery's net power, not the charger's input power.`);
		}
	}

	if (stoppedWithVbus) {
		add('critical', 'The charger reports a valid input but is not charging',
			`CHGIN_DTLS 3 with CHG_DTLS ${chgDtls.join(', ')}. The watchdog may have stopped it (max77705_wdt=1), or the charger is in a fault/thermal state. Check the wdt lines and the 5-minute charger dump.`);
	} else if (dischargingWithVbus) {
		add('critical', 'VBUS is present but the battery is discharging',
			`The charger's input is below the system load, or the charger has stopped. Compare the battery current with the input limit.`);
	} else if (charging.length > 0 && stopping.length === 0) {
		add('info', 'The charger stayed in charging/full for the whole captured log',
			`${charging.length} state line(s); CHG_DTLS ${chgDtls.length ? [...new Set(chgDtls)].join(', ') : 'not logged'}. No watchdog stop is visible.`);
	}

	if (limits.length > 0) {
		if (limits.length === 1) {
			add('info', 'Only one charger dump',
				`CNFG_09 ${formatCode(firstLimit.code)} = ${formatMa(firstLimit.ma)}. Run at least 20-30 minutes for a trend.`);
		} else if (maxLimitDrop >= 50) {
			/* Samsung's AICL work lowers CNFG_09 by REDUCE_CURRENT_STEP (100 mA); 25 mA is the register's step */
			const hundreds = limitDrops.length > 0 && limitDrops.every((d) => d.by >= 100 && d.by % 100 === 0);
			add('warn', 'The input current limit fell',
				`From ${formatMa(peakLimit)} (${formatCode(peakAt.code)}) to ${formatMa(lastLimit.ma)} (${formatCode(lastLimit.code)}): ` +
				`${limitDrops.map((d) => `${d.from}→${d.to} mA`).join(', ')}. ` +
				(hundreds
					? 'The steps are 100 mA multiples, the step Samsung\'s AICL work uses: a source whose VBUS sags (cable, charger, port) makes the charger reduce its input. HakiOS itself never writes CNFG_09, so confirm whether it happened at boot or after a hotplug.'
					: 'HakiOS never writes CNFG_09 (its only charger write is the watchdog\'s CNFG_06), so this is the boot state or the charger itself, not the governor.'));
		} else {
			add('info', 'The input current limit did not fall',
				`It stayed at ${formatMa(firstLimit.ma)} (CNFG_09 ${formatCode(firstLimit.code)}). A falling battery current with a constant limit is not AICL: it is the battery's CV taper, the charger's thermal regulation, or the system load rising.`);
		}
		if (firstLimit && firstLimit.ma <= 550) {
			const lowPct = lastState && lastState.pct != null && lastState.pct < 60;
			add('warn', 'The input limit is at or near the USB 2.0 500 mA limit',
				`CNFG_09 ${formatCode(firstLimit.code)} = ${formatMa(firstLimit.ma)}. A hub port is normally a standard USB data port (SDP) and advertises 500 mA; its 2 A rating is capacity, not what it offers the phone. A wall charger the phone sees as a USB host, or a PC USB port used for the console, gives the same. A 0.47 A port reading is consistent with this limit.` +
				(lowPct ? ` The last state is ${lastState.pct.toFixed(2)}%, far from the CV phase: the 500 mA is not the cell asking for less.` : ''));
		}
	}

	if (firstFast) {
		const codeText = (x) => x.code == null ? 'code not in this line' : `code 0x${x.code.toString(16)}`;
		add('info', 'The fast-charge current (CNFG_02)',
			`${formatMa(firstFast.ma)} (${codeText(firstFast)}) at the first dump` +
			(lastFast && lastFast.ma !== firstFast.ma ? `, ${formatMa(lastFast.ma)} (${codeText(lastFast)}) at the last.` : '.'));
	}

	if (currentDrop != null && currentDrop > 150) {
		const lastPct = lastState ? lastState.pct : null;
		if (maxLimitDrop >= 50) {
			add('warn', 'The battery current fell with the input limit',
				`The battery current fell by ${Math.round(currentDrop)} mA and the input limit by ${maxLimitDrop} mA. The limit is the cause, not a CV taper: the source/cable/port or the boot state set it. Repeat the plug-order test and check BC_STATUS (charger type) in the usb switch lines.`);
		} else if (lastPct != null && lastPct >= 80) {
			add('info', 'The battery current fell at a high state of charge: a normal CV taper is likely',
				`The last sample is ${lastPct.toFixed(2)}% and the input limit did not fall. Above about 80% the charger's CV phase lowers the current; this is not a fault.`);
		} else if (maxTemp != null && maxTemp >= 45) {
			add('warn', 'The battery current fell while the phone was warm and the input limit stayed the same',
				`${formatC(maxTemp)} at the last sample. The charger's own thermal regulation or the rising system load can do this; the battery's CV taper is less likely below 80%.`);
		} else {
			add('warn', limits.length === 0 ? 'The battery current fell; the input limit was not logged' : 'The battery current fell without an input-limit change',
				`${Math.round(currentDrop)} mA at ${lastPct == null ? '?' : lastPct.toFixed(2)}%, ${formatC(maxTemp)}. ` +
				(limits.length === 0
					? 'Add max77705_diag=1: without CNFG_09 a limit drop and a CV taper look the same.'
					: 'A CV taper is unlikely at this charge and temperature. Check the system load (screen on, camera, Wi-Fi) and the charger\'s temperature.'));
		}
	}

	if (maxTemp != null) {
		if (maxTemp >= ANDROID_TMU_STOP_C) {
			add('critical', 'The battery thermistor reached the kernel\'s stop threshold',
				`${formatC(maxTemp)}; tmu=3 stops at ${ANDROID_TMU_STOP_C} °C (tmu_batt_stop).`);
		} else if (maxTemp >= ANDROID_TEMP_HIGH_C) {
			add('warn', 'The battery is at Android\'s high-temperature event',
				`${formatC(maxTemp)}; Android\'s battery,temp_high_threshold_event is ${ANDROID_TEMP_HIGH_C} °C. Do not judge charging at this temperature.`);
		} else if (maxTemp >= 45) {
			add('info', 'The battery is warm',
				`${formatC(maxTemp)} at the last sample; Android limits the charger from ${ANDROID_CHG_HIGH_C} °C (charger IC) and stops at ${ANDROID_TMU_STOP_C} °C (battery).`);
		}
	}

	if (wdt.started) {
		const sum = wdt.summaries.length ? wdt.summaries[wdt.summaries.length - 1] : null;
		if (wdt.failed > 0 || (sum && sum.failed > 0)) {
			add('critical', 'The watchdog kick failed',
				`${wdt.failed + (sum ? sum.failed : 0)} failed kick(s). The charger may stop. Check CNFG_00 WDTEN and CNFG_06.`);
		} else if (wdt.kicked > 0 || (sum && sum.kicks > 0)) {
			add('info', 'The charger watchdog was fed',
				`${Math.max(wdt.kicked, sum ? sum.kicks : 0)} kick(s)` + (sum ? `; ${sum.skipped} skipped because WDTEN was off` : '') + '.');
		} else {
			add('warn', 'max77705_wdt=1 was requested but no kick is visible',
				'If the run is longer than 30 s and the watchdog is on, look for `max77705: wdt: CNFG_00 ... (WDTEN on)`; without a kick the charger stops within minutes.');
		}
	} else if (diags.some((d) => d.wdten === true)) {
		add('warn', 'The charger watchdog is on but max77705_wdt=1 was not in the log',
			'Add max77705_wdt=1, or the charger may stop after its watchdog expires.');
	}

	if (displayOff === 0) {
		add('info', 'No display-off event in this log',
			'If the screen stayed on, panel_sleep=1 and sleep_cores=1 had nothing to do: they only act when iOS turns the display off. For screen-on heat the levers are gov_policy=2 with cpufreq_gov_big_max=, mali_gov_frame=, the camera, Wi-Fi/Bluetooth and the load.');
	} else {
		add('info', 'The screen went off and on',
			`${displayOff} off / ${displayOn} on; ${panelSleep} panel_sleep line(s); ${coreOff} core(s) taken off, ${coreOn} started again.` +
			(panelSleep === 0 ? ' If panel_sleep=1 was requested, no `s6e3ha8: panel_sleep:` line means it did not run.' : ''));
		if (panelSleep === 0) {
			add('warn', 'The screen went off but the panel was not put to sleep',
				`${displayOff} display-off event(s), no \`s6e3ha8: panel_sleep:\` line. Without panel_sleep=1 the S6E3HA8 keeps scanning, and DSIM/DECON stay up: the phone is still warm with a dark screen (kernel docs_screen-off-power.md).`);
		}
	}
	if (fpsOffCount >= 10) {
		add('warn', 'Frames are still presented with the screen off',
			`${fpsOffCount} fps line(s) came after the display-off event` +
			(fpsOffMhz != null ? `, GPU ${Math.round(fpsOffMhz)} MHz on average` : '') +
			'. panel_sleep puts the panel to sleep, but the DECON/DSIM clocks are not turned off (kernel docs_screen-off-power.md), so the frame thread and the display pipeline can keep running. This is not an app to close; it needs the display clock-off part of the CPU_SUSPEND work.');
	}

	if (bigMhz.length > 0) {
		const sustained = bigMhz.length >= 5 && bigHighPct >= 50;
		add(sustained ? 'warn' : 'info', 'The M3s\' clock',
			`At or above 1.7 GHz in ${bigHighPct}% of the ${bigMhz.length} cpufreq_gov line(s)` +
			(maxCpuTemp != null ? `; the hottest big-cluster reading was ${formatC(maxCpuTemp)}` : '') +
			(sustained ? '. The M3s at that rate are a sustained heat source. gov_policy=3 does not park them once the big zone is cooling (c->thermal != 0), and when it does park two it allows 2314 MHz.' : '.'));
		if (maxCpuTemp != null && maxCpuTemp >= 80) {
			add('warn', 'The big cluster is at its cooling point',
				`${formatC(maxCpuTemp)}; the governor starts lowering the ceiling at 83 °C, reaches the lowest level at 96 °C, and recovers only under 78 °C. With gov_policy=2 all four M3s are online; cpufreq_gov_big_max is the ceiling that works (policy 3 overrides it).`);
		} else if (bigMhz.length >= 5 && maxCpuTemp != null && maxCpuTemp >= 78 && bigHighPct != null && bigHighPct >= 50) {
			add('info', 'The CPU is a candidate heat source',
				`${formatC(maxCpuTemp)} with the M3s at or above 1.7 GHz in ${bigHighPct}% of the samples. Test cpufreq_gov_big_max=1469000, then 1261000, at the same workload.`);
		}
	}

	if (maxLittle != null && maxLittle >= 76 && (maxCpuTemp == null || maxLittle > maxCpuTemp + 5)) {
		add('warn', 'The A55 cluster is hot',
			`${formatC(maxLittle)}; Android cools LITTLE from 76 °C. With the screen off, sleep_cores=1 only takes the M3s; sleep_cores=2 also takes the A55s. Prove the wake before keeping it.`);
	}
	if (coreOff > 0 && maxCpuTemp != null && maxCpuTemp < 70 && maxLittle != null && maxLittle < 70 &&
	    (maxG3d == null || maxG3d < 85) && (maxIsp == null || maxIsp < 91)) {
		add('info', 'The CPU and ISP zones are cool with the M3s off',
			`big ${formatC(maxCpuTemp)}, little ${formatC(maxLittle)}, G3D ${formatC(maxG3d)}, ISP ${formatC(maxIsp)}; if the mainboard is still hot, the heat is outside these zones: the PMIC, the radios, the display pipeline or the SoC uncore.`);
	}

	if (gpuSamples.length > 0) {
		add('info', 'The GPU\'s clock and temperature',
			`${gpuSamples.length} fps line(s): ${gpuMaxMhz} MHz at most, ` +
			`${gpuAvgBusy == null ? '?' : Math.round(gpuAvgBusy)}% busy on average` +
			(maxG3d != null ? `, G3D ${formatC(maxG3d)} at most` : '') + '.');
	}
	if (gpuFloorPct != null && gpuFloorPct >= 50 && gpuAvgBusy != null && gpuAvgBusy < 35) {
		add('warn', 'The GPU was held above its load',
			`${gpuFloorSamples} of ${gpuSamples.length} samples (${gpuFloorPct}%) at 455 MHz or more with under 25% GPU busy; ` +
			`${Math.round(gpuAvgBusy)}% busy on average. mali_gov_frame=572 keeps that floor while any frame arrived in the last 100 ms, ` +
			'and a nearly static screen still presents about 10 frames a second. Test mali_gov_frame=455, then 0.');
	}
	if (maxG3d != null && maxG3d >= 95) {
		add('critical', 'The G3D reached the second GPU cap',
			`${formatC(maxG3d)}; from 95 °C the GPU is held at 260 MHz. The SoC is hot: check whether the CPU or the charger is heating it, and whether the phone can shed the load.`);
	} else if (maxG3d != null && maxG3d >= 85) {
		add('warn', 'The G3D reached the first GPU cap',
			`${formatC(maxG3d)}; from 85 °C the GPU is held at 455 MHz. The cap is applied after the frame floor, so a 572 MHz floor can sit there until the sensor crosses 85 °C.`);
	}
	if (gpuSamples.length === 0 && gpus.length > 0) {
		add('info', 'The GPU was not running in this log',
			`${gpus.length} fps line(s), all "gpu: none". ` +
			(displayOff > 0 && fpsOffCount > 0
				? `${fpsOffCount} of them came while the display was off: the frame thread/display pipeline still ran; `
				: 'The display still scanned; ') +
			`the GPU's heat is not part of this run.`);
	} else if (gpus.length === 0 && maliBusy.length > 0) {
		add('info', 'The GPU busy lines have no clock or temperature',
			'`fps_log=1` adds the GPU\'s MHz, busy share and G3D sensor once a second; `mali: GPU busy` alone is a 5 s window.');
	}
	if (maliBusy.length > 0 && gpus.length === 0) {
		add('info', 'The GPU\'s 5 s windows',
			`${maliBusy.length} line(s), ${Math.round(maliBusyAvg)}% busy on average. Add fps_log=1 for the clock and G3D temperature.`);
	}

	if (maxIsp != null && maxIsp >= 91 && (maxCpuTemp == null || maxIsp >= maxCpuTemp) && (maxG3d == null || maxIsp >= maxG3d)) {
		add('warn', 'The ISP/camera is the hottest TMU zone',
			`${formatC(maxIsp)}; Android starts cooling the ISP at 91 °C. Check \`exynos_camera\` for a stream with the screen off, and close Camera.app or any reader.`);
	}

	if (charging.length > 0 && maxTemp != null && maxTemp >= 42 && maxTemp < 45) {
		add('info', 'The battery is warm while charging',
			`${formatC(maxTemp)}; the charger adds heat of its own. Repeat the same workload with the cable out: if the phone cools, the charger is part of the source, not the SoC.`);
	}

	if (cameraOn > 0) {
		add('info', 'The front camera streamed during the run',
			`${cameraOn} start(s), ${cameraOff} stop(s). The lazy-stream default (5 November) starts it only for a reader; an older image streams it from boot.`);
	}

	/* the heat, by the evidence the log carries: CPU, GPU, charger/battery, panel */
	const heatCpu = highest(maxCpuTemp, maxTmuBig);
	const heatGpu = highest(maxG3d, maxTmuG3d);
	const heatSources = [];
	if (heatCpu != null && heatCpu >= 80) {
		heatSources.push(`CPU: big zone ${formatC(heatCpu)}` +
			(bigMhz.length >= 5 && bigHighPct != null ? `, M3s >= 1.7 GHz in ${bigHighPct}% of samples` : ''));
	} else if (bigMhz.length >= 5 && heatCpu != null && heatCpu >= 78 && bigHighPct != null && bigHighPct >= 50) {
		heatSources.push(`CPU: big zone ${formatC(heatCpu)}, M3s >= 1.7 GHz in ${bigHighPct}% of samples`);
	}
	if (maxLittle != null && maxLittle >= 76 && (heatCpu == null || maxLittle > heatCpu)) {
		heatSources.push(`A55: little zone ${formatC(maxLittle)}`);
	}
	if (heatGpu != null && heatGpu >= 85) {
		heatSources.push(`GPU: G3D ${formatC(heatGpu)}` + (gpuFloorPct != null && gpuFloorPct >= 50 ? `, clock floor ${gpuFloorPct}% of samples` : ''));
	} else if (gpuFloorPct != null && gpuFloorPct >= 50 && gpuAvgBusy != null && gpuAvgBusy < 35) {
		heatSources.push(`GPU: clock floor ${gpuFloorPct}% of samples at under 25% busy (${Math.round(gpuAvgBusy)}% average)`);
	}
	if (maxIsp != null && maxIsp >= 91 && (maxCpuTemp == null || maxIsp >= maxCpuTemp) && (maxG3d == null || maxIsp >= maxG3d)) {
		heatSources.push(`ISP/camera: ${formatC(maxIsp)} (the hottest TMU zone)`);
	}
	if (fpsOffCount >= 10) {
		heatSources.push('display pipeline: frames still presented with the panel asleep');
	}
	if (charging.length > 0 && maxTemp != null && maxTemp >= 42) {
		heatSources.push(`charger/battery: ${formatC(maxTemp)} while charging`);
	}
	if (displayOff > 0 && panelSleep === 0) {
		heatSources.push('panel: still scanning while the screen was off');
	}
	if (heatSources.length === 0 && tmuLines.length > 0) {
		const hottest = tmuLines.reduce((best, x) => (x.hottestC > best.hottestC ? x : best));
		heatSources.push(`${hottest.hottest} zone: ${formatC(hottest.hottestC)} (the hottest TMU zone, below its cooling point)`);
	}
	if (heatSources.length === 0) {
		heatSources.push('none above these thresholds: the log does not name the source; check radios, camera, sensor hub and the charger next');
	}

	/* --- the next tests, chosen by the findings --- */

	const next = [];
	if (limits.length === 0) {
		next.push('Add max77705_diag=1 to the boot arguments and repeat, or CNFG_09/CNFG_02 cannot be read.');
	}
	if (maxLimitDrop >= 50 || (firstLimit && firstLimit.ma <= 550)) {
		next.push('Repeat with a known-good 5 V/2 A charger and a short, thick cable, and with the phone NOT on the PC USB port. A 0.47 A battery current is the USB 2.0 500 mA class.');
		next.push('Put a USB power meter in line: if VBUS is 5 V and the input current is ~0.9-1 A while the battery current is 0.47 A, the rest is the system load; if the meter also falls to ~0.5 A, the source/cable/AICL is the limit.');
		next.push('Test the plug order: boot with the charger already in, note CNFG_09/current; unplug and plug it back, note them again. If the limit falls after a hotplug, the driver never re-applies the charger-type limit.');
	}
	if (bigHighPct != null && bigHighPct >= 50 && maxCpuTemp != null && maxCpuTemp >= 78) {
		next.push('Repeat the same workload with `gov_policy=2 cpufreq_gov_big_max=1469000`, then `1261000`, and compare the `cpufreq_gov` big MHz/load/temp lines. Do not use gov_policy=3 for this: it overrides the cap and can run two M3s at 2314 MHz.');
		next.push('If the cap helps, keep policy 2 and consider the opt-in "cool law" patch sketched in docs/heat.md (not in the tree yet).');
	}
	if (gpuFloorPct != null && gpuFloorPct >= 50 && gpuAvgBusy != null && gpuAvgBusy < 35) {
		next.push('Repeat with `mali_gov_frame=455`, then `0`, at the same workload; compare the `fps:` MHz/busy/G3D lines. A static screen presenting 10 frames a second can hold 572 MHz all day.');
	}
	if (gpus.length === 0) {
		next.push('Add `fps_log=1` to the boot arguments: without it the log has no GPU clock, busy share or G3D temperature.');
	}
	if (displayOff > 0 && panelSleep === 0) {
		next.push('Add `panel_sleep=1` and repeat the screen-off run; check `s6e3ha8: panel_sleep:` lines and the picture when it wakes.');
	}
	if (displayOff > 0 && panelSleep > 0 && coreOff === 0) {
		next.push('The display went off and panel_sleep ran, but no core was taken off: check that `sleep_cores=1` was in the boot arguments and that the display-off request reached `GenericARMPE`. Without the `taken off` line the M3s were never parked.');
	} else if (displayOff > 0 && panelSleep > 0 && coreOff > 0) {
		next.push('panel_sleep and sleep_cores both ran: read the `tmu:` zones and the `cpufreq_gov` little MHz/load. If little is hot, test `sleep_cores=2` (after proving the wake); if the four zones are cool and the board center is hot, the remainder is the display pipeline/uncore/PMIC.');
	}
	if (fpsOffCount >= 10) {
		next.push('The `fps:` lines continue after the display-off event: the frame thread/display pipeline is still presenting with the panel asleep. A governor or `panel_sleep` change will not stop it; the DECON/DSIM clock-off belongs with the `CPU_SUSPEND` work.');
	}
	if (charging.length > 0 && maxTemp != null && maxTemp >= 42) {
		next.push('Repeat the same workload with the charger out and with it in; if the battery temperature falls only when unplugged, the charger is part of the heat and the fix is the source/current, not the CPU law.');
	}
	next.push('For a charging run, do not capture over the PC USB cable: boot on the wall charger, let it run 20-30 minutes, then plug into the PC and type `log` at the console (it reprints the kernel log from its start), or use time_limit to return to TWRP.');
	next.push('Read CNFG_09 as (code + 1) × 25 mA (0x13 = 500, 0x23 = 900, 0x3B = 1500, 0x47 = 1800 mA); CNFG_02 as code × 50 mA (0x0A = 500, 0x1E = 1500, 0x2A = 2100 mA).');

	return {
		states, diags, fgs, cpus, gpus, maliBusy, tmuLines, cools, events, wdt,
		firstState, lastState, firstCharging, lastCharging,
		currentDrop, minCurrent, maxCurrent, maxTemp, minTemp,
		firstLimit, lastLimit, peakLimit, maxLimitDrop, limitDrops,
		firstFast, lastFast, fastMa: firstFast ? firstFast.ma : null, chgDtls, chginValid,
		displayOff, displayOn, panelSleep, coreOff, coreOn, cameraOn, cameraOff, fpsOffCount,
		bigHigh, bigHighPct, bigMhz, maxCpuTemp, maxLitTemp, maxTmuLittle,
		gpuSamples, gpuMaxMhz, gpuAvgBusy, gpuFloorSamples, gpuFloorPct, maxG3d, maliBusyAvg,
		maxTmuBig, maxTmuG3d, maxIsp, coolBig, coolLit, cap455, cap260, heatSources,
		heat: {
			maxBigC: heatCpu,
			maxLitC: maxLittle,
			bigHighPct,
			maxG3dC: heatGpu,
			gpuAvgBusyPct: gpuAvgBusy,
			gpuMaxMhz,
			gpuFloorPct,
			gpuSamples: gpuSamples.length,
			maxTmuBigC: maxTmuBig,
			maxTmuG3dC: maxTmuG3d,
			maxIspC: maxIsp,
			tmuSamples: tmuLines.length,
			maxBatteryC: maxTemp,
			charging: charging.length > 0,
			displayOff,
			panelSleep,
			coreOff,
			coreOn,
			fpsOff: fpsOffCount,
			coolBig,
			coolLit,
			cap455,
			cap260,
			sources: heatSources
		},
		findings, next
	};
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* the report                                                                                                         */

function report(input, log, a) {
	const out = [];
	const p = (s = '') => out.push(s);

	p('MAX77705 log analysis');
	p('=====================');
	p(`Input: ${input}`);
	p(`Lines: ${log.lines}; max77705 lines: ${log.max77705Lines}; battery state: ${a.states.length}; charger dumps: ${a.diags.length}; gauge lines: ${a.fgs.length}; cpufreq lines: ${a.cpus.length}`);
	p();

	if (a.firstState && a.lastState) {
		p('Battery');
		p('-------');
		p(`  ${a.firstState.pct.toFixed(2)}% -> ${a.lastState.pct.toFixed(2)}%   ` +
			`${a.firstState.mv} -> ${a.lastState.mv} mV   ` +
			`${a.firstState.ma} -> ${a.lastState.ma} mA   ` +
			`${formatC(a.firstState.tempC)} -> ${formatC(a.lastState.tempC)}`);
		p(`  current while charging: ${a.minCurrent == null ? '?' : Math.min(...a.states.filter((s) => s.status !== 'discharging').map((s) => s.ma))} .. ${a.maxCurrent == null ? '?' : Math.max(...a.states.filter((s) => s.status !== 'discharging').map((s) => s.ma))} mA` +
			(a.currentDrop == null ? '' : `; first -> last ${a.firstCharging.ma} -> ${a.lastCharging.ma} mA (${Math.round(a.currentDrop)} mA drop)`));
		p(`  battery temperature: ${formatC(a.minTemp)} .. ${formatC(a.maxTemp)}; design ${a.firstState.design} mAh, full ${a.firstState.full} mAh, ${a.firstState.cycles} cycles`);
		p();
	}

	if (a.diags.length > 0) {
		p('Charger');
		p('-------');
		if (a.firstLimit) {
			p(`  input limit: ${formatMa(a.firstLimit.ma)} (CNFG_09 ${formatCode(a.firstLimit.code)}) -> ${formatMa(a.lastLimit.ma)} (${formatCode(a.lastLimit.code)})` +
				(a.maxLimitDrop ? `; largest fall ${a.maxLimitDrop} mA` : '; no fall'));
		}
		if (a.firstFast) {
			p(`  fast charge (CNFG_02): ${formatMa(a.firstFast.ma)} (${formatCode(a.firstFast.code)})` +
				(a.lastFast && a.lastFast.ma !== a.firstFast.ma ? ` -> ${formatMa(a.lastFast.ma)} (${formatCode(a.lastFast.code)})` : ''));
		}
		p(`  CHG_DTLS seen: ${a.chgDtls.length ? [...new Set(a.chgDtls)].join(', ') : '?'}; CHGIN_DTLS 3 (valid): ${a.chginValid.length} dump(s); WDTEN: ${a.diags.some((d) => d.wdten) ? 'on' : a.diags.some((d) => d.wdten === false) ? 'off' : '?'}`);
		p(`  net battery power: ${a.firstState ? (a.firstState.mv * a.firstState.ma / 1000).toFixed(0) : '?'} mW -> ${a.lastState ? (a.lastState.mv * a.lastState.ma / 1000).toFixed(0) : '?'} mW`);
		p();
	}

	if (a.cpus.length > 0) {
		p('CPU and screen');
		p('--------------');
		p(`  cpufreq_gov lines: ${a.cpus.length}; big at or above 1.7 GHz: ${a.bigHigh}/${a.bigMhz.length}; hottest big: ${formatC(a.maxCpuTemp)}`);
		p(`  display: ${a.displayOff} off / ${a.displayOn} on; panel_sleep: ${a.panelSleep}; cores off/on: ${a.coreOff}/${a.coreOn}; fps while off: ${a.fpsOffCount}; camera stream: ${a.cameraOn} start(s), ${a.cameraOff} stop(s)`);
		p();
	}

	if (a.gpus.length > 0 || a.maliBusy.length > 0) {
		p('GPU');
		p('---');
		if (a.gpuSamples.length > 0) {
			p(`  fps lines: ${a.gpuSamples.length}; clock ${a.gpuMaxMhz} MHz at most; busy ${a.gpuAvgBusy == null ? '?' : Math.round(a.gpuAvgBusy)}% on average; G3D ${formatC(a.maxG3d)} at most`);
			p(`  at 455 MHz or more with under 25% busy: ${a.gpuFloorSamples}/${a.gpuSamples.length} (${a.gpuFloorPct}%)`);
		} else {
			p(`  fps lines: ${a.gpus.length} (no GPU); mali: GPU busy lines: ${a.maliBusy.length}`);
		}
		if (a.maliBusy.length > 0) {
			p(`  mali: GPU busy windows: ${a.maliBusy.length}, ${Math.round(a.maliBusyAvg)}% busy on average`);
		}
		p(`  G3D caps seen: 455 MHz ${a.cap455}, 260 MHz ${a.cap260}`);
		p();
	}

	p('Heat');
	p('----');
	p(`  CPU: big ${formatC(a.heat.maxBigC)}, little ${formatC(a.heat.maxLitC)}` + (a.heat.bigHighPct != null ? `, M3s >= 1.7 GHz in ${a.heat.bigHighPct}% of ${a.bigMhz.length} sample(s)` : '') + `; M3s off/on: ${a.heat.coreOff}/${a.heat.coreOn}; ceiling changes: big ${a.heat.coolBig}, lit ${a.heat.coolLit}`);
	if (a.heat.gpuSamples > 0) {
		p(`  GPU: ${a.heat.gpuMaxMhz} MHz, ${a.heat.gpuAvgBusyPct == null ? '?' : Math.round(a.heat.gpuAvgBusyPct)}% busy, G3D ${formatC(a.heat.maxG3dC)}; clock floor ${a.heat.gpuFloorPct}% of samples`);
	} else if (a.gpus.length > 0) {
		p(`  GPU: ${a.gpus.length} fps line(s), all "gpu: none"; ` + (a.fpsOffCount > 0 ? `${a.fpsOffCount} while the display was off` : 'the display still scanned'));
	} else {
		p('  GPU: no fps line (add fps_log=1)');
	}
	if (a.heat.tmuSamples > 0) {
		p(`  TMU: big ${formatC(a.heat.maxTmuBigC)}, G3D ${formatC(a.heat.maxTmuG3dC)}, ISP ${formatC(a.heat.maxIspC)} (${a.heat.tmuSamples} summary line(s))`);
	}
	p(`  battery: ${formatC(a.heat.maxBatteryC)}` + (a.heat.charging ? ' while charging' : '') + `; screen off/on: ${a.heat.displayOff}/${a.displayOn}; panel_sleep lines: ${a.heat.panelSleep}`);
	p(`  likely: ${a.heat.sources.join('; ')}`);
	p();

	p('Findings');
	p('--------');
	if (a.findings.length === 0) {
		p('  (nothing to flag)');
	} else {
		for (const f of a.findings) {
			const mark = f.level === 'critical' ? '[!]' : f.level === 'warn' ? '[!]' : f.level === 'info' ? '[i]' : '[?]';
			p(`  ${mark} ${f.title}`);
			p(`      ${f.detail}`);
		}
	}
	p();

	p('What to test next');
	p('----------------');
	for (const s of a.next) {
		p(`  - ${s}`);
	}
	p();

	if (a.states.length > 0) {
		p('Battery samples (every 5 minutes)');
		p('--------------------------------');
		p('   #   time     %      mV    mA   °C   status');
		const step = Math.max(1, Math.ceil(a.states.length / 40));
		for (let i = 0; i < a.states.length; i += step) {
			const s = a.states[i];
			p(`  ${String(i + 1).padStart(2)}  ${String(s.t ?? '').padStart(6)}  ${s.pct.toFixed(2).padStart(6)}  ${String(s.mv).padStart(5)}  ${String(s.ma).padStart(4)}  ${s.tempC.toFixed(1).padStart(4)}  ${s.statusText}`);
		}
		if (step > 1) {
			p(`  (${a.states.length} samples; every ${step}th shown)`);
		}
		p();
	}

	if (a.diags.length > 0) {
		p('Charger dumps');
		p('-------------');
		p('   #   CNFG_09  input mA  CNFG_02  fast mA  CHG_DTLS  CHGIN_DTLS  WDTEN');
		for (let i = 0; i < a.diags.length; i++) {
			const d = a.diags[i];
			const c9 = d.inputCode == null ? '?' : '0x' + d.inputCode.toString(16);
			const c2 = d.cnfg02Code == null ? '?' : '0x' + d.cnfg02Code.toString(16);
			p(`  ${String(i + 1).padStart(2)}  ${c9.padStart(7)}  ${String(d.inputMa ?? '?').padStart(8)}  ${c2.padStart(7)}  ${String(d.fastMa ?? '?').padStart(7)}  ${String(d.chgDtls ?? '?').padStart(8)}  ${String(d.chginDtls ?? '?').padStart(10)}  ${d.wdten == null ? '?' : d.wdten ? '1' : '0'}`);
		}
		p();
	}

	return out.join('\n');
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* CSV and JSON                                                                                                       */

function csv(log, a) {
	const rows = [['kind', 'time_s', 'percent', 'mV', 'mA', 'temp_C', 'status', 'CNFG_09', 'input_mA', 'CNFG_02', 'fast_mA', 'CHG_DTLS', 'CHGIN_DTLS', 'WDTEN', 'big_MHz', 'cpu_temp_C', 'gpu_MHz', 'gpu_busy_pct', 'g3d_C']];
	for (const s of a.states) {
		rows.push(['state', s.t ?? '', s.pct, s.mv, s.ma, s.tempC, s.statusText, '', '', '', '', '', '', '', '', '', '', '', '']);
	}
	for (const d of a.diags) {
		rows.push(['diag', d.t ?? '', '', '', '', '', '', d.inputCode == null ? '' : '0x' + d.inputCode.toString(16), d.inputMa ?? '', d.cnfg02Code == null ? '' : '0x' + d.cnfg02Code.toString(16), d.fastMa ?? '', d.chgDtls ?? '', d.chginDtls ?? '', d.wdten == null ? '' : d.wdten ? 1 : 0, '', '', '', '', '']);
	}
	for (const c of a.cpus) {
		rows.push(['cpu', c.t ?? c.s, '', '', '', '', '', '', '', '', '', '', '', '', c.bigMhz, c.tempBigC ?? '', '', '', '']);
	}
	for (const g of a.gpus) {
		rows.push(['fps', g.t ?? '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', g.mhz, g.busyPct, g.g3dC]);
	}
	const esc = (v) => {
		const s = String(v);
		return /[",\n]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s;
	};
	return rows.map((r) => r.map(esc).join(',')).join('\n') + '\n';
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* self-test                                                                                                          */

function selfTest() {
	const regs = {};
	for (const r of RAW_REGS) {
		regs[r] = 0x00;
	}
	regs[0xb2] = 0x40;        /* CHGIN_OK */
	regs[0xb3] = 0x60;        /* CHGIN_DTLS 3 */
	regs[0xb4] = 0x02;        /* CHG_DTLS 2, BAT_DTLS 0 */
	regs[0xb5] = 0x00;
	regs[0xb7] = 0x11;        /* mode 1, WDTEN 1 */
	regs[0xb9] = 0x2a;        /* 2100 mA */
	regs[0xc0] = 0x23;        /* 900 mA */

	const raw = (r) => '0xb2-0xc5:' + RAW_REGS.map((x) => (regs[x] ?? 0).toString(16).padStart(2, '0')).join(' ');
	const log = [
		'max77705: step 5: reporting every 5 s',
		'max77705: wdt: the charger\'s watchdog kicked every 30 s while it is on (max77705_wdt=1)',
		'max77705: wdt: CNFG_00 0x11 (WDTEN on); CNFG_06 0x0 written 0x1: kicked (0)',
		'max77705: every 5 minutes: 50.00%, 4000 mV, 880 mA, 35.0 C (ADC 1234), a battery, charging, 1500 of 2967 mAh (full 2800), 300 cycles',
		'max77705: charger every 5 minutes: ' + raw(0x23),
		'max77705: charger every 5 minutes: CNFG_00 mode 0x1 WDTEN 1; CHGIN_DTLS 3; CHG_DTLS 0x2 BAT_DTLS 0; BYP_DTLS 0x0; fast charge 2100 mA; input limit code 0x23 (CNFG_09)',
		'max77705: every 5 minutes: 51.00%, 4050 mV, 780 mA, 38.0 C (ADC 1234), a battery, charging, 1600 of 2967 mAh (full 2800), 300 cycles',
		'max77705: charger every 5 minutes: CNFG_00 mode 0x1 WDTEN 1; CHGIN_DTLS 3; CHG_DTLS 0x2 BAT_DTLS 0; BYP_DTLS 0x0; fast charge 2100 mA; input limit code 0x1f (CNFG_09)',
		'max77705: every 5 minutes: 52.00%, 4100 mV, 580 mA, 42.0 C (ADC 1234), a battery, charging, 1700 of 2967 mAh (full 2800), 300 cycles',
		'max77705: charger every 5 minutes: CNFG_00 mode 0x1 WDTEN 1; CHGIN_DTLS 3; CHG_DTLS 0x2 BAT_DTLS 0; BYP_DTLS 0x0; fast charge 2100 mA; input limit code 0x17 (CNFG_09)',
		'max77705: every 5 minutes: 53.00%, 4150 mV, 470 mA, 45.0 C (ADC 1234), a battery, charging, 1800 of 2967 mAh (full 2800), 300 cycles',
		'max77705: charger every 5 minutes: CNFG_00 mode 0x1 WDTEN 1; CHGIN_DTLS 3; CHG_DTLS 0x2 BAT_DTLS 0; BYP_DTLS 0x0; fast charge 2100 mA; input limit code 0x13 (CNFG_09)',
		'cpufreq_gov: 10 s: lit 1248 MHz load 31% (avg 22%, 2 online, 1794 max, measured 1251) | big 1794 MHz load 64% (avg 60%, 4 online, 1794 max, measured 1794) | temp big 70 lit 65 C | 4 changes | boost: 0 touch, 0 frames, 0 raised, off',
		'GenericARMPE: the display off (iOS\'s power request)',
		'fps: 0 refreshes missed while moving, the longest gap 0.0 ms; zc: 8 in place, 0 copied, 0 into the one shown; gpu: 12% busy, 900 us a frame shown, 60 jobs (15 us each, 2 us queued), 572 MHz (mali_gov), 1 switches, G3D 78 C',
		'fps: 0 refreshes missed while moving, the longest gap 0.0 ms; zc: 8 in place, 0 copied, 0 into the one shown; gpu: 8% busy, 700 us a frame shown, 48 jobs (14 us each, 1 us queued), 455 MHz (mali_gov), 1 switches, G3D 82 C',
		'fps: 1 refreshes missed while moving, the longest gap 16.7 ms; zc: 8 in place, 0 copied, 0 into the one shown; gpu: 40% busy, 2500 us a frame shown, 120 jobs (20 us each, 5 us queued), 572 MHz (mali_gov), 3 switches, G3D 86 C',
		'mali: GPU busy 22% of 5 s: vertex and tiler 10 jobs 6 ms (600 us each), fragment 120 jobs 40 ms (333 us each)',
		'cpufreq_gov: big at 83.1 C: its ceiling now 1690000 kHz',
		'mali: mali_gov: the G3D at 85.0 C: 455 MHz at most now',
		'tmu: 12 sensors read; hottest big at 83.0 C; big1=83.0 big2=82.0 little5=66.0 g3d1=86.0 isp2=70.0'
	].join('\n');

	const parsed = parseLog(log);
	const a = analyze(parsed);
	const errors = [];
	if (parsed.states.length !== 4) {
		errors.push(`state lines: ${parsed.states.length}, wanted 4`);
	}
	if (parsed.diags.length !== 5) {
		errors.push(`diag lines: ${parsed.diags.length}, wanted 5`);
	}
	if (a.firstLimit?.ma !== 900) {
		errors.push(`first input limit: ${a.firstLimit?.ma}, wanted 900`);
	}
	if (a.lastLimit?.ma !== 500) {
		errors.push(`last input limit: ${a.lastLimit?.ma}, wanted 500`);
	}
	if (a.maxLimitDrop !== 400) {
		errors.push(`input-limit drop: ${a.maxLimitDrop}, wanted 400`);
	}
	if (Math.round(a.currentDrop) !== 410) {
		errors.push(`battery-current drop: ${a.currentDrop}, wanted 410`);
	}
	if (a.maxTemp !== 45) {
		errors.push(`max temperature: ${a.maxTemp}, wanted 45`);
	}
	if (!a.findings.some((f) => /AICL|input current limit fell/.test(f.title))) {
		errors.push('no AICL/input-limit finding');
	}
	if (a.fastMa !== 2100) {
		errors.push(`fast charge: ${a.fastMa}, wanted 2100`);
	}
	if (parsed.gpus.length !== 3) {
		errors.push(`fps lines: ${parsed.gpus.length}, wanted 3`);
	}
	if (a.displayOff !== 1 || a.fpsOffCount !== 3) {
		errors.push(`fps while the display was off: ${a.fpsOffCount}, wanted 3 (display-off events ${a.displayOff})`);
	}
	if (parsed.maliBusy.length !== 1) {
		errors.push(`mali: GPU busy lines: ${parsed.maliBusy.length}, wanted 1`);
	}
	if (parsed.cools.length !== 2) {
		errors.push(`cooling lines: ${parsed.cools.length}, wanted 2`);
	}
	if (parsed.tmuLines.length !== 1) {
		errors.push(`TMU summary lines: ${parsed.tmuLines.length}, wanted 1`);
	}
	if (a.maxTmuBig !== 83 || a.maxIsp !== 70) {
		errors.push(`TMU big/ISP: ${a.maxTmuBig}/${a.maxIsp}, wanted 83/70`);
	}
	if (a.gpuMaxMhz !== 572 || a.maxG3d !== 86) {
		errors.push(`GPU max MHz/G3D: ${a.gpuMaxMhz}/${a.maxG3d}, wanted 572/86`);
	}
	if (a.gpuFloorPct !== 67) {
		errors.push(`GPU floor share: ${a.gpuFloorPct}, wanted 67`);
	}
	if (a.coolBig !== 1 || a.cap455 !== 1) {
		errors.push(`thermal events: big ${a.coolBig}, cap455 ${a.cap455}, wanted 1/1`);
	}
	if (!a.findings.some((f) => /GPU was held above its load/.test(f.title))) {
		errors.push('no GPU clock-floor finding');
	}
	if (!a.heat.sources.some((s) => /^GPU/.test(s))) {
		errors.push('the heat summary did not name the GPU');
	}
	if (errors.length > 0) {
		console.error('self-test FAILED:');
		for (const e of errors) {
			console.error('  ' + e);
		}
		process.exit(1);
	}
	console.log('self-test: ok (4 state lines, 5 charger dumps, CNFG_09 900->500 mA, current 880->470 mA, input-limit finding, 3 fps lines, GPU floor at 572/455 MHz, G3D 86 C, big ceiling 1690 kHz, GPU cap 455 MHz, TMU big/ISP 83/70 C)');
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* main                                                                                                               */

function main(argv) {
	let csvPath = null;
	let jsonPath = null;
	const files = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--self-test') {
			selfTest();
			return 0;
		} else if (arg === '--csv') {
			csvPath = argv[++i];
			if (!csvPath) {
				console.error('--csv needs a path');
				return 1;
			}
		} else if (arg === '--json') {
			jsonPath = argv[++i];
			if (!jsonPath) {
				console.error('--json needs a path');
				return 1;
			}
		} else if (arg === '--help' || arg === '-h') {
			console.log('usage: node tools/analyze-max77705-log.mjs [--csv out.csv] [--json out.json] LOG');
			console.log('       node tools/analyze-max77705-log.mjs --self-test');
			return 0;
		} else if (arg.startsWith('-') && arg !== '-') {
			console.error(`unknown option: ${arg}`);
			return 1;
		} else {
			files.push(arg);
		}
	}
	if (files.length !== 1) {
		console.error('usage: node tools/analyze-max77705-log.mjs [--csv out.csv] [--json out.json] LOG');
		return 1;
	}

	const text = files[0] === '-' ? readFileSync(0, 'utf8') : readFileSync(files[0], 'utf8');
	const log = parseLog(text);
	if (log.max77705Lines === 0) {
		console.error(`${files[0]}: no max77705 line found`);
		return 2;
	}
	const a = analyze(log);
	console.log(report(files[0], log, a));
	if (csvPath) {
		writeFileSync(csvPath, csv(log, a));
		console.error(`csv: ${csvPath}`);
	}
	if (jsonPath) {
		writeFileSync(jsonPath, JSON.stringify({
			input: files[0],
			lines: log.lines,
			max77705Lines: log.max77705Lines,
			states: a.states,
			diags: a.diags,
			fgs: a.fgs,
			cpus: a.cpus,
			gpus: a.gpus,
			maliBusy: a.maliBusy,
			cools: a.cools,
			heat: a.heat,
			findings: a.findings,
			next: a.next
		}, null, 2) + '\n');
		console.error(`json: ${jsonPath}`);
	}
	return 0;
}

process.exitCode = main(process.argv.slice(2));
