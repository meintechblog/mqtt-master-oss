/**
 * Shared utilities for Loxone control display logic.
 * Extracted from loxone-controls.js for reusability and testability.
 */
import { fmtNum } from './format.js';

/** Extract the primary display value from states based on control type */
export function primaryValue(type, states, extra) {
  if (!states) return null;
  switch (type) {
    case 'Switch':
      return states.active != null ? (states.active.value > 0 ? 'ON' : 'OFF') : null;
    case 'Dimmer':
      return states.position != null ? states.position.value + '%' : null;
    case 'InfoOnlyAnalog':
      return states.value != null ? fmtNum(states.value.value) : null;
    case 'InfoOnlyDigital':
      return states.active != null ? (states.active.value > 0 ? 'Active' : 'Inactive') : null;
    case 'Meter':
      return states.actual != null ? fmtNum(states.actual.value) + ' kW' : null;
    case 'Jalousie':
      return states.position != null ? Math.round(states.position.value * 100) + '%' : null;
    case 'Gate':
      return states.position != null ? Math.round(states.position.value * 100) + '%'
        : states.active != null ? (states.active.value > 0 ? 'Open' : 'Closed') : null;
    case 'IRoomControllerV2':
      return states.tempActual != null ? fmtNum(states.tempActual.value) + ' °C' : null;
    case 'Ventilation':
      return states.level != null ? 'Level ' + states.level.value : null;
    case 'LightControllerV2': {
      // Show resolved mood name from config mapping
      if (extra?.activeMoodName) return extra.activeMoodName;
      const moods = extra?.moods || [];
      const moodIds = extra?.activeMoodIds || [];
      if (moodIds.length > 0) {
        const mood = moods.find(m => m.id === moodIds[0]);
        return mood ? mood.name : `Mood #${moodIds[0]}`;
      }
      return null;
    }
    default:
      return null;
  }
}

export function isControllable(type) {
  return ['Switch', 'Dimmer', 'LightControllerV2', 'Jalousie',
    'Gate', 'Slider', 'ColorPickerV2', 'IRoomControllerV2',
    'Alarm', 'TimedSwitch', 'Ventilation',
  ].includes(type);
}

export function isSensor(type) {
  return ['InfoOnlyAnalog', 'InfoOnlyDigital', 'Meter'].includes(type);
}

/** Flatten controls + subcontrols into a single list of controllable/sensor items */
export function flattenControls(controls) {
  const items = [];
  for (const ctrl of controls) {
    // Always include the parent control if it's controllable/sensor
    if (isControllable(ctrl.type) || isSensor(ctrl.type)) {
      items.push({
        uuid: ctrl.uuid,
        name: ctrl.name,
        type: ctrl.type,
        room: ctrl.room,
        category: ctrl.category,
        topic: ctrl.topic,
        states: ctrl.states,
        moods: ctrl.moods,
        activeMoodIds: ctrl.activeMoodIds,
        activeMoodName: ctrl.activeMoodName,
        parentName: null,
      });
    }
    // Include sub-controls
    if (ctrl.subControls && ctrl.subControls.length > 0) {
      for (const sub of ctrl.subControls) {
        if (isControllable(sub.type) || isSensor(sub.type)) {
          items.push({
            uuid: sub.uuid,
            name: sub.name,
            type: sub.type,
            room: ctrl.room,
            category: ctrl.category,
            topic: sub.topic,
            states: sub.states,
            parentName: ctrl.name,
          });
        }
      }
    }
  }
  return items;
}

/** Group items by category, then by room within each category */
export function buildGroups(items) {
  const catMap = {};
  for (const item of items) {
    const cat = item.category || 'Other';
    if (!catMap[cat]) catMap[cat] = {};
    const room = item.room || 'Unknown';
    if (!catMap[cat][room]) catMap[cat][room] = [];
    catMap[cat][room].push(item);
  }
  return Object.entries(catMap)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([cat, rooms]) => ({
      category: cat,
      rooms: Object.entries(rooms)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([room, items]) => ({
          room,
          items: items.sort((a, b) => {
            const ac = isControllable(a.type) ? 0 : 1;
            const bc = isControllable(b.type) ? 0 : 1;
            if (ac !== bc) return ac - bc;
            return a.name.localeCompare(b.name);
          }),
        })),
      count: Object.values(rooms).reduce((s, r) => s + r.length, 0),
    }));
}
