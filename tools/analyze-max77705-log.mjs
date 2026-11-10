#!/usr/bin/env node
/*
 * analyze-max77705-log.mjs: read a HakiOS kernel log (the USB console, `log` at the console, dmesg, or
 * /proc/last_kmsg after a run) and say what the MAX77705 charger and gauge did.
 *
 * It reads only the log; nothing here talks to the phone. It is for the question "the phone is hot and the
 * charging current fell from 0.88 A to 0.47 A: is that the charger, the cable, the input limit, the battery's
 * CV taper, or the system load?".
 *
 * Build a log with (the first three are read-only):
 *
 *   max77705_wdt=1 max77705_diag=1 max77705_fg_s=30 gov_policy=3 tmu=3
 *
 * and, when the screen is meant to be off, panel_sleep=1 sleep_cores=1.  See docs/power-charging.md.
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

	return { lines: lines.length, max77705Lines, states, diags, fgs, cpus, events, wdt, firstT, lastT };
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
	const { states, diags, fgs, cpus, events, wdt } = log;
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

	/* the CPU governor: how often the M3s sat at or near their ceiling */
	const bigMhz = cpus.map((c) => c.bigMhz).filter(Number.isFinite);
	const bigHigh = bigMhz.filter((m) => m >= 1700).length;
	const cpuTemp = cpus.map((c) => c.tempBigC).filter(Number.isFinite);
	const maxCpuTemp = cpuTemp.length ? Math.max(...cpuTemp) : null;

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
			add('warn', 'The input limit is at or near the USB 2.0 500 mA limit',
				`CNFG_09 ${formatCode(firstLimit.code)} = ${formatMa(firstLimit.ma)}. A wall charger that the phone sees as a USB host, or a PC USB port used for the console, gives this. 0.47 A at the battery is consistent with it.`);
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
		add('info', 'The screen was on for the whole captured log',
			'panel_sleep=1 and sleep_cores=1 had nothing to do: they only act when iOS turns the display off. For screen-on heat the levers are gov_policy=3, the camera, Wi-Fi/Bluetooth and the load.');
	} else {
		add('info', 'The screen went off and on',
			`${displayOff} off / ${displayOn} on; ${panelSleep} panel_sleep line(s); ${coreOff} core(s) taken off, ${coreOn} started again.` +
			(panelSleep === 0 ? ' If panel_sleep=1 was requested, no `s6e3ha8: panel_sleep:` line means it did not run.' : ''));
	}

	if (bigMhz.length > 0) {
		const highPct = Math.round(100 * bigHigh / bigMhz.length);
		add(highPct >= 50 ? 'warn' : 'info', 'The M3s\' clock',
			`At or above 1.7 GHz in ${highPct}% of the cpufreq_gov lines` +
			(maxCpuTemp != null ? `; the hottest big-cluster reading was ${formatC(maxCpuTemp)}` : '') +
			'. gov_policy=3 parks two M3s when the load allows and the big zone is under 70 °C.');
		if (maxCpuTemp != null && maxCpuTemp >= 80) {
			add('warn', 'The big cluster is near its cooling point',
				`${formatC(maxCpuTemp)}; the governor starts lowering the ceiling at 83 °C and takes the M3s away at 96 °C.`);
		}
	}

	if (cameraOn > 0) {
		add('info', 'The front camera streamed during the run',
			`${cameraOn} start(s), ${cameraOff} stop(s). The lazy-stream default (5 November) starts it only for a reader; an older image streams it from boot.`);
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
	if (displayOff === 0) {
		next.push('For screen-on heat: rebuild with a 5 November or later kernel (cam_s9 lazy stream), run with gov_policy=3, and compare the cpufreq_gov lines at the same load.');
	}
	next.push('For a charging run, do not capture over the PC USB cable: boot on the wall charger, let it run 20-30 minutes, then plug into the PC and type `log` at the console (it reprints the kernel log from its start), or use time_limit to return to TWRP.');
	next.push('Read CNFG_09 as (code + 1) × 25 mA (0x13 = 500, 0x23 = 900, 0x3B = 1500, 0x47 = 1800 mA); CNFG_02 as code × 50 mA (0x0A = 500, 0x1E = 1500, 0x2A = 2100 mA).');

	return {
		states, diags, fgs, cpus, events, wdt,
		firstState, lastState, firstCharging, lastCharging,
		currentDrop, minCurrent, maxCurrent, maxTemp, minTemp,
		firstLimit, lastLimit, peakLimit, maxLimitDrop, limitDrops,
		firstFast, lastFast, fastMa: firstFast ? firstFast.ma : null, chgDtls, chginValid,
		displayOff, displayOn, panelSleep, coreOff, coreOn, cameraOn, cameraOff,
		bigHigh, bigMhz, maxCpuTemp,
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
		p(`  display: ${a.displayOff} off / ${a.displayOn} on; panel_sleep: ${a.panelSleep}; cores off/on: ${a.coreOff}/${a.coreOn}; camera stream: ${a.cameraOn} start(s), ${a.cameraOff} stop(s)`);
		p();
	}

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
	const rows = [['kind', 'time_s', 'percent', 'mV', 'mA', 'temp_C', 'status', 'CNFG_09', 'input_mA', 'CNFG_02', 'fast_mA', 'CHG_DTLS', 'CHGIN_DTLS', 'WDTEN', 'big_MHz', 'cpu_temp_C']];
	for (const s of a.states) {
		rows.push(['state', s.t ?? '', s.pct, s.mv, s.ma, s.tempC, s.statusText, '', '', '', '', '', '', '', '', '']);
	}
	for (const d of a.diags) {
		rows.push(['diag', d.t ?? '', '', '', '', '', '', d.inputCode == null ? '' : '0x' + d.inputCode.toString(16), d.inputMa ?? '', d.cnfg02Code == null ? '' : '0x' + d.cnfg02Code.toString(16), d.fastMa ?? '', d.chgDtls ?? '', d.chginDtls ?? '', d.wdten == null ? '' : d.wdten ? 1 : 0, '', '']);
	}
	for (const c of a.cpus) {
		rows.push(['cpu', c.t ?? c.s, '', '', '', '', '', '', '', '', '', '', '', '', c.bigMhz, c.tempBigC ?? '']);
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
		'cpufreq_gov: 10 s: lit 1248 MHz load 31% (avg 22%, 2 online, 1794 max, measured 1251) | big 1794 MHz load 64% (avg 60%, 4 online, 1794 max, measured 1794) | temp big 70 lit 65 C | 4 changes | boost: 0 touch, 0 frames, 0 raised, off'
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
	if (errors.length > 0) {
		console.error('self-test FAILED:');
		for (const e of errors) {
			console.error('  ' + e);
		}
		process.exit(1);
	}
	console.log('self-test: ok (4 state lines, 5 charger dumps, CNFG_09 900->500 mA, current 880->470 mA, input-limit finding)');
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
			findings: a.findings,
			next: a.next
		}, null, 2) + '\n');
		console.error(`json: ${jsonPath}`);
	}
	return 0;
}

process.exitCode = main(process.argv.slice(2));
