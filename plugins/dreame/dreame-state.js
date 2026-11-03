/*
 * Parts of this file are ported from two MIT-licensed projects:
 *
 *   - TA2k/ioBroker.dreame (main.js)
 *     Copyright (c) 2024-2026 TA2k <tombox2020@gmail.com>
 *   - Tasshack/dreame-vacuum
 *     (custom_components/dreame_vacuum/dreame/protocol.py, const.py, types.py)
 *     Copyright (c) 2022 Tasshack
 *
 * MIT License
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * Dreame robot state codes (MIOT siid 2 / piid 1) mapped to the small
 * vocabulary published on `haus/sauger/<key>/zustand`.
 *
 * The code names come from `DreameVacuumState` in Tasshack/dreame-vacuum
 * (const.py); the grouping into our vocabulary is our own decision.
 */
export const ZUSTAENDE = Object.freeze([
  'reinigt', 'pausiert', 'zurueck', 'station', 'laedt', 'fehler', 'unbekannt',
]);

export const STATE_MAP = Object.freeze({
  1: 'reinigt',   // SWEEPING
  3: 'pausiert',  // PAUSED
  4: 'fehler',    // ERROR
  5: 'zurueck',   // RETURNING
  6: 'laedt',     // CHARGING
  7: 'reinigt',   // MOPPING
  8: 'station',   // DRYING
  9: 'station',   // WASHING
  10: 'zurueck',  // RETURNING_TO_WASH
  12: 'reinigt',  // SWEEPING_AND_MOPPING
  13: 'laedt',    // CHARGING_COMPLETED
  15: 'reinigt',  // CLEAN_SUMMON
  16: 'station',  // STATION_RESET
  17: 'zurueck',  // RETURNING_INSTALL_MOP
  18: 'zurueck',  // RETURNING_REMOVE_MOP
  19: 'reinigt',  // WATER_CHECK
  20: 'reinigt',  // CLEAN_ADD_WATER
  21: 'pausiert', // WASHING_PAUSED
  22: 'station',  // AUTO_EMPTYING
  23: 'reinigt',  // REMOTE_CONTROL
  24: 'laedt',    // SMART_CHARGING
  25: 'reinigt',  // SECOND_CLEANING
  26: 'reinigt',  // HUMAN_FOLLOWING
  27: 'reinigt',  // SPOT_CLEANING
  28: 'zurueck',  // RETURNING_AUTO_EMPTY
  30: 'station',  // STATION_CLEANING
  31: 'zurueck',  // RETURNING_TO_DRAIN
  32: 'station',  // DRAINING
  33: 'station',  // AUTO_WATER_DRAINING
  34: 'station',  // EMPTYING
  35: 'station',  // DUST_BAG_DRYING
  36: 'pausiert', // DUST_BAG_DRYING_PAUSED
  37: 'reinigt',  // HEADING_TO_EXTRA_CLEANING
  // Intentionally not mapped (-> unbekannt): 2 IDLE (the plan has no "bereit"
  // value), 11 BUILDING, 14 UPGRADING, 29 WAITING_FOR_TASK.
  // unbelegt: codes above 37 exist in newer firmware; they fall through to
  // "unbekannt" until verified on the real X40 / E30.
});

/**
 * @param {unknown} stateCode raw value of siid 2 / piid 1
 * @param {unknown} _errorCode raw value of siid 2 / piid 2 (reserved: the state
 *   code alone decides, a stale error code must not mask a running robot)
 * @returns {string} one of ZUSTAENDE
 */
export function mapState(stateCode, _errorCode) {
  const n = typeof stateCode === 'string' && stateCode.trim() !== '' ? Number(stateCode) : stateCode;
  if (typeof n !== 'number' || !Number.isFinite(n)) return 'unbekannt';
  return STATE_MAP[n] ?? 'unbekannt';
}
