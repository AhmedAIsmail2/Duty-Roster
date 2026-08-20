const {
  useState,
  useEffect,
  useRef,
  useCallback
} = React;

// Offline storage shim: mirrors the (key, sharedBool) signature the app was
// originally written against, but always persists to this device's localStorage.
const storage = {
  async get(key) {
    try {
      const v = localStorage.getItem(key);
      return v !== null ? {
        value: v
      } : null;
    } catch {
      return null;
    }
  },
  async set(key, value) {
    try {
      localStorage.setItem(key, value);
      return {
        value
      };
    } catch {
      return null;
    }
  }
};
window.storage = storage;

// ---------- Theme tokens ----------
const C = {
  bg: "#12161c",
  panel: "#1a2028",
  panelAlt: "#20272f",
  border: "#2b333d",
  borderLight: "#3a4552",
  amber: "#c68a3f",
  amberSoft: "#c68a3f22",
  olive: "#6b7d54",
  oliveSoft: "#6b7d5433",
  red: "#b6543f",
  redSoft: "#b6543f22",
  info: "#6f93c9",
  infoSoft: "#6f93c922",
  text: "#eae6db",
  textMute: "#93a0ac",
  textFaint: "#5f6b78"
};
const FONT_DISPLAY = "'Cairo', sans-serif";
const FONT_BODY = "'Tajawal', sans-serif";
const FONT_MONO = "'JetBrains Mono', monospace";
const SHIFTS = [{
  id: "morning",
  label: "خدمة الصبح",
  time: "٧:٠٠ ص – ٣:٠٠ م"
}, {
  id: "afternoon",
  label: "خدمة العصر",
  time: "٣:٠٠ م – ١١:٠٠ م"
}, {
  id: "night",
  label: "خدمة الليل",
  time: "١١:٠٠ م – ٧:٠٠ ص"
}];
const WEEKDAY_NAMES = ["الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
// getDay(): 0=Sunday...6=Saturday. Borg6 keeps its name (not "gate") on Fri(5)/Sat(6)/Sun(0)
const GATE_EXCEPTION_DAYS = [0, 5, 6];
// How many shifts back to search for a soldier's last duty before giving up (≈ 13 days)
const LOOKBACK_SHIFTS_CAP = 40;
const LOOKBACK_DAYS = 14;
function pad(n) {
  return n < 10 ? "0" + n : "" + n;
}
function dateKey(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function fmtDateArabic(d) {
  const months = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
  return `${WEEKDAY_NAMES[d.getDay()]} ${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}
function addDays(d, n) {
  const nd = new Date(d);
  nd.setDate(nd.getDate() + n);
  return nd;
}
function uid() {
  return Math.random().toString(36).slice(2, 10);
}
function positionsForShift(shiftId, dateObj) {
  if (shiftId === "morning") {
    const isGate = !GATE_EXCEPTION_DAYS.includes(dateObj.getDay());
    return [{
      key: "borg2",
      label: "برج 2"
    }, {
      key: "borg3",
      label: "برج 3"
    }, {
      key: "borg6",
      label: isGate ? "البوابة الجنوبية" : "برج 6"
    }];
  }
  return [{
    key: "borg2",
    label: "برج 2"
  }, {
    key: "borg3",
    label: "برج 3"
  }, {
    key: "borg6",
    label: "برج 6"
  }];
}
function emptyShiftData() {
  return {
    borg2: null,
    borg3: null,
    borg6: null,
    car: null,
    carEnabled: false
  };
}
function emptyDayData() {
  return {
    morning: emptyShiftData(),
    afternoon: {
      ...emptyShiftData(),
      carEnabled: false
    },
    night: {
      ...emptyShiftData(),
      carEnabled: false
    }
  };
}
function getAssignedIds(shiftData) {
  if (!shiftData) return [];
  return [shiftData.borg2, shiftData.borg3, shiftData.borg6, shiftData.car].filter(Boolean);
}
function prevShiftRef(date, shiftId) {
  if (shiftId === "morning") return {
    date: addDays(date, -1),
    shiftId: "night"
  };
  if (shiftId === "afternoon") return {
    date,
    shiftId: "morning"
  };
  return {
    date,
    shiftId: "afternoon"
  };
}

/**
 * For every soldier, find how many shifts back their last assigned duty was,
 * relative to (date, shiftId), plus which position/tower they held there.
 * Returns: soldierId -> { gap, posKey, posDate, posShiftId }
 * Soldiers not found within the lookback cap are omitted (fresh / no history).
 */
function computeGaps(date, shiftId, soldiers, getDayData) {
  const result = {};
  let remaining = new Set(soldiers.map(s => s.id));
  let cur = {
    date,
    shiftId
  };
  let gap = 1;
  while (remaining.size > 0 && gap <= LOOKBACK_SHIFTS_CAP) {
    cur = prevShiftRef(cur.date, cur.shiftId);
    const dayData = getDayData(cur.date);
    const shiftData = dayData[cur.shiftId] || {};
    ["borg2", "borg3", "borg6", "car"].forEach(posKey => {
      const id = shiftData[posKey];
      if (id && remaining.has(id)) {
        result[id] = {
          gap,
          posKey,
          posDate: cur.date,
          posShiftId: cur.shiftId
        };
        remaining.delete(id);
      }
    });
    gap++;
  }
  return result;
}
function lastTowerLabel(info) {
  if (!info) return null;
  if (info.posKey === "car") return "السيارة";
  const positions = positionsForShift(info.posShiftId, info.posDate);
  const p = positions.find(x => x.key === info.posKey);
  return p ? p.label : null;
}

// ---------- Leave management ----------
function parseDateKey(dk) {
  const [y, m, d] = dk.split("-").map(Number);
  return new Date(y, m - 1, d);
}
const MONTH_NAMES_SHORT = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
function fmtDayMonth(date) {
  return `${date.getDate()} ${MONTH_NAMES_SHORT[date.getMonth()]}`;
}
const PAYMENT_TYPES = [{
  type: "payment1",
  label: "الدفع الأول",
  anchorDay: 4
}, {
  type: "payment2",
  label: "الدفع الثاني",
  anchorDay: 14
}, {
  type: "payment3",
  label: "الدفع الثالث",
  anchorDay: 24
}];
function paymentWindow(year, monthIndex, anchorDay) {
  const start = new Date(year, monthIndex, anchorDay);
  const end = addDays(start, 9); // 10-day window inclusive
  return {
    start,
    end
  };
}
// Recomputes the actual (possibly shortened) leave range from the fixed 10-day
// window, given how many days the soldier actually takes and which end the
// deduction comes off of.
function computeActualRange(windowStartKey, windowEndKey, days, deductFrom) {
  if (deductFrom === "start") {
    const end = windowEndKey;
    const start = dateKey(addDays(parseDateKey(end), -(days - 1)));
    return {
      startDate: start,
      endDate: end
    };
  }
  const start = windowStartKey;
  const end = dateKey(addDays(parseDateKey(start), days - 1));
  return {
    startDate: start,
    endDate: end
  };
}
// A soldier's paymentLeave membership (soldier.paymentLeave = { type, days, deductFrom })
// is permanent — it doesn't need re-adding every month. This computes the actual date
// range that membership resolves to for a given calendar month.
function paymentLeaveRangeForMonth(paymentLeave, year, monthIndex) {
  const anchor = PAYMENT_TYPES.find(p => p.type === paymentLeave.type).anchorDay;
  const {
    start,
    end
  } = paymentWindow(year, monthIndex, anchor);
  return computeActualRange(dateKey(start), dateKey(end), paymentLeave.days, paymentLeave.deductFrom);
}
// Payment-3 windows can spill into the next calendar month, so a date early in a month
// might actually belong to last month's payment-3 window — check both.
function isOnPaymentLeaveOn(paymentLeave, dk) {
  const d = parseDateKey(dk);
  const year = d.getFullYear();
  const month = d.getMonth();
  let range = paymentLeaveRangeForMonth(paymentLeave, year, month);
  if (dk >= range.startDate && dk <= range.endDate) return true;
  const prevMonth = month === 0 ? 11 : month - 1;
  const prevYear = month === 0 ? year - 1 : year;
  range = paymentLeaveRangeForMonth(paymentLeave, prevYear, prevMonth);
  return dk >= range.startDate && dk <= range.endDate;
}
function isOnLeave(soldier, dk) {
  if ((soldier.leaves || []).some(l => dk >= l.startDate && dk <= l.endDate)) return true;
  if (soldier.paymentLeave && isOnPaymentLeaveOn(soldier.paymentLeave, dk)) return true;
  return false;
}
// For the "في إجازة (نوع)" badge — which leave (if any) covers this date.
function activeLeaveFor(soldier, dk) {
  const exceptional = (soldier.leaves || []).find(l => dk >= l.startDate && dk <= l.endDate);
  if (exceptional) return exceptional;
  if (soldier.paymentLeave && isOnPaymentLeaveOn(soldier.paymentLeave, dk)) {
    return {
      type: soldier.paymentLeave.type
    };
  }
  return null;
}

// ---------- Picker (tap-to-select sheet) ----------
function PickerSheet({
  title,
  options,
  selectedId,
  onSelect,
  onClose,
  notes = {},
  noteKinds = {},
  lastTower = {}
}) {
  return /*#__PURE__*/React.createElement("div", {
    onClick: onClose,
    style: {
      position: "fixed",
      inset: 0,
      background: "#00000099",
      zIndex: 50,
      display: "flex",
      alignItems: "flex-end",
      justifyContent: "center"
    }
  }, /*#__PURE__*/React.createElement("div", {
    onClick: e => e.stopPropagation(),
    style: {
      background: C.panel,
      borderTop: `1px solid ${C.borderLight}`,
      borderRadius: "18px 18px 0 0",
      width: "100%",
      maxWidth: 480,
      maxHeight: "70vh",
      overflowY: "auto",
      padding: "18px 16px 28px",
      boxShadow: "0 -8px 30px #00000066"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 40,
      height: 4,
      background: C.borderLight,
      borderRadius: 4,
      margin: "0 auto 14px"
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: FONT_DISPLAY,
      fontWeight: 700,
      fontSize: 16,
      color: C.text,
      marginBottom: 12,
      textAlign: "center"
    }
  }, title), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      onSelect(null);
      onClose();
    },
    style: {
      width: "100%",
      textAlign: "right",
      padding: "13px 14px",
      marginBottom: 6,
      borderRadius: 10,
      border: `1px solid ${C.border}`,
      background: selectedId == null ? C.redSoft : "transparent",
      color: selectedId == null ? C.red : C.textMute,
      fontFamily: FONT_BODY,
      fontSize: 15,
      fontWeight: 600,
      cursor: "pointer"
    }
  }, "— بدون تعيين —"), options.map(o => {
    const note = notes[o.id];
    const noteC = noteKinds[o.id] === "leave" ? C.info : C.amber;
    const noteCSoft = noteKinds[o.id] === "leave" ? C.infoSoft : C.amberSoft;
    const tower = lastTower[o.id];
    const isSelected = selectedId === o.id;
    return /*#__PURE__*/React.createElement("button", {
      key: o.id,
      onClick: () => {
        onSelect(o.id);
        onClose();
      },
      style: {
        width: "100%",
        textAlign: "right",
        padding: "11px 14px",
        marginBottom: 6,
        borderRadius: 10,
        border: `1px solid ${isSelected ? C.olive : note ? noteC + "55" : C.border}`,
        background: isSelected ? C.oliveSoft : note ? noteCSoft : "transparent",
        color: isSelected ? C.olive : C.text,
        fontFamily: FONT_BODY,
        fontSize: 15,
        fontWeight: isSelected ? 700 : 500,
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-end",
        gap: 2
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        width: "100%",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center"
      }
    }, /*#__PURE__*/React.createElement("span", null, o.name), isSelected && /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 13
      }
    }, "✓")), /*#__PURE__*/React.createElement("span", {
      style: {
        display: "flex",
        gap: 8,
        alignSelf: "flex-start"
      }
    }, note && /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 11,
        fontFamily: FONT_MONO,
        color: noteC,
        fontWeight: 700
      }
    }, note), tower && /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 11,
        fontFamily: FONT_BODY,
        color: C.textFaint,
        fontWeight: 600
      }
    }, "آخر برج: ", tower)));
  }), options.length === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      color: C.textFaint,
      textAlign: "center",
      padding: "20px 0",
      fontFamily: FONT_BODY,
      fontSize: 14
    }
  }, "لا يوجد عساكر متاحين للتعيين هنا")));
}

// ---------- Position row ----------
function PositionRow({
  label,
  options,
  selectedId,
  allSoldiers,
  onChange,
  notes = {},
  noteKinds = {},
  lastTower = {}
}) {
  const [open, setOpen] = useState(false);
  const soldierName = allSoldiers.find(s => s.id === selectedId)?.name;
  const selectedNote = selectedId && notes[selectedId];
  const selectedNoteColor = selectedId && noteKinds[selectedId] === "leave" ? C.info : C.amber;
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("button", {
    onClick: () => setOpen(true),
    style: {
      width: "100%",
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      padding: "12px 14px",
      borderRadius: 10,
      marginBottom: 8,
      border: `1px solid ${C.border}`,
      background: C.panelAlt,
      cursor: "pointer",
      textAlign: "right"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: FONT_BODY,
      fontSize: 14,
      color: C.textMute,
      fontWeight: 600
    }
  }, label), /*#__PURE__*/React.createElement("span", {
    style: {
      display: "flex",
      flexDirection: "column",
      alignItems: "flex-end",
      gap: 1
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: FONT_BODY,
      fontSize: 14.5,
      fontWeight: 700,
      color: soldierName ? C.text : C.textFaint
    }
  }, soldierName || "بدون تعيين"), selectedNote && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 10.5,
      fontFamily: FONT_MONO,
      color: selectedNoteColor,
      fontWeight: 700
    }
  }, selectedNote))), open && /*#__PURE__*/React.createElement(PickerSheet, {
    title: label,
    options: options,
    selectedId: selectedId,
    onSelect: onChange,
    onClose: () => setOpen(false),
    notes: notes,
    noteKinds: noteKinds,
    lastTower: lastTower
  }));
}

// ---------- Shift Card ----------
const SHIFT_ORDER = ["morning", "afternoon", "night"];
function hasWorkedEarlierToday(fullDayData, shiftId, soldierId) {
  const idx = SHIFT_ORDER.indexOf(shiftId);
  for (let i = 0; i < idx; i++) {
    if (getAssignedIds(fullDayData[SHIFT_ORDER[i]]).includes(soldierId)) return true;
  }
  return false;
}
function shiftEndDate(date, shiftId) {
  if (shiftId === "night") {
    const d = addDays(date, 1);
    d.setHours(7, 0, 0, 0);
    return d;
  }
  const d = new Date(date);
  d.setHours(shiftId === "morning" ? 15 : 23, 0, 0, 0);
  return d;
}
function ShiftCard({
  shift,
  dateObj,
  data,
  fullDayData,
  soldiers,
  allSoldiers,
  onUpdate,
  isActive,
  isPast,
  gaps
}) {
  const positions = positionsForShift(shift.id, dateObj);
  const canHaveCar = true; // car service can now be toggled in any shift, including morning

  // gap === 1 -> mandatory 8h rest right after their last shift: fully hidden
  const hiddenByRest = new Set(soldiers.filter(s => gaps[s.id]?.gap === 1).map(s => s.id));
  // Per-soldier note shown in the picker: either "back from leave [+ 8h rest]" on their
  // return day (until they're actually assigned that day), or the usual cumulative
  // rest-hours label (gap >= 3), whichever applies.
  const notes = {};
  const noteKinds = {}; // 'leave' | 'rest' — used to color the note differently
  const lastTower = {};
  const viewedDayKey = dateKey(dateObj);
  const prevDayKey = dateKey(addDays(dateObj, -1));
  soldiers.forEach(s => {
    const info = gaps[s.id];
    let note = null;
    let kind = null;
    const justReturned = !isOnLeave(s, viewedDayKey) && isOnLeave(s, prevDayKey);
    if (justReturned && !hasWorkedEarlierToday(fullDayData, shift.id, s.id)) {
      kind = "leave";
      if (shift.id === "morning") note = "رجع من إجازة";else if (shift.id === "afternoon") note = "رجع من إجازة + راحة ٨ ساعة";else note = "رجع من إجازة + راحة ١٦ ساعة";
    } else if (info && info.gap >= 3) {
      kind = "rest";
      note = `راحة ${(info.gap - 1) * 8} ساعة`;
    }
    notes[s.id] = note;
    noteKinds[s.id] = kind;
    if (info) lastTower[s.id] = lastTowerLabel(info);
  });
  const allAssignedThisShift = positions.reduce((acc, p) => {
    if (data[p.key]) acc[p.key] = data[p.key];
    return acc;
  }, {});
  if (data.carEnabled && data.car) allAssignedThisShift.car = data.car;
  const optionsFor = posKey => {
    const takenElsewhere = new Set(Object.entries(allAssignedThisShift).filter(([k]) => k !== posKey).map(([, v]) => v));
    const currentId = data[posKey];
    return soldiers.filter(s => s.id === currentId || !hiddenByRest.has(s.id) && !takenElsewhere.has(s.id));
  };
  return /*#__PURE__*/React.createElement("div", {
    style: {
      background: C.panel,
      border: `1px solid ${isActive ? C.amber : C.border}`,
      borderRadius: 14,
      padding: 16,
      marginBottom: 14,
      position: "relative",
      overflow: "hidden",
      opacity: isPast ? 0.75 : 1
    }
  }, isActive && /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      top: 0,
      right: 0,
      left: 0,
      height: 3,
      background: `linear-gradient(90deg, ${C.amber}, transparent)`
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "baseline",
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: FONT_DISPLAY,
      fontSize: 17,
      fontWeight: 800,
      color: isActive ? C.amber : C.text,
      display: "flex",
      alignItems: "center",
      gap: 8
    }
  }, shift.label, isActive && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      fontFamily: FONT_MONO,
      color: C.amber
    }
  }, "● جارية الآن"), isPast && !isActive && /*#__PURE__*/React.createElement("span", {
    style: {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      width: 18,
      height: 18,
      borderRadius: "50%",
      background: C.oliveSoft,
      color: C.olive,
      fontSize: 11,
      fontWeight: 900
    }
  }, "✓"))), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: FONT_MONO,
      fontSize: 12.5,
      color: C.textFaint,
      direction: "ltr"
    }
  }, shift.time)), positions.map(p => /*#__PURE__*/React.createElement(PositionRow, {
    key: p.key,
    label: p.label,
    options: optionsFor(p.key),
    allSoldiers: allSoldiers,
    selectedId: data[p.key],
    onChange: id => onUpdate({
      ...data,
      [p.key]: id
    }),
    notes: notes,
    noteKinds: noteKinds,
    lastTower: lastTower
  })), canHaveCar && /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      padding: "10px 14px",
      borderRadius: 10,
      marginTop: 4,
      background: data.carEnabled ? C.oliveSoft : C.panelAlt,
      border: `1px solid ${data.carEnabled ? C.olive : C.border}`
    }
  }, /*#__PURE__*/React.createElement("label", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 10,
      cursor: "pointer",
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    checked: !!data.carEnabled,
    onChange: e => onUpdate({
      ...data,
      carEnabled: e.target.checked,
      car: e.target.checked ? data.car : null
    }),
    style: {
      width: 18,
      height: 18,
      accentColor: C.olive,
      cursor: "pointer"
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: FONT_BODY,
      fontSize: 14,
      fontWeight: 700,
      color: data.carEnabled ? C.olive : C.textMute
    }
  }, "خدمة السيارة ", data.carEnabled ? "مفعّلة" : "غير مفعّلة"))), canHaveCar && data.carEnabled && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 8
    }
  }, /*#__PURE__*/React.createElement(PositionRow, {
    label: "السيارة",
    options: optionsFor("car"),
    allSoldiers: allSoldiers,
    selectedId: data.car,
    onChange: id => onUpdate({
      ...data,
      car: id
    }),
    notes: notes,
    noteKinds: noteKinds,
    lastTower: lastTower
  })));
}

// ---------- Soldiers manager ----------
// ---------- Leave type chooser sheet ----------
function LeaveTypeSheet({
  onClose,
  onPickPayment,
  onConfirmExceptional
}) {
  const [mode, setMode] = useState("choose"); // 'choose' | 'exceptional'
  const [days, setDays] = useState(3);
  const [startDate, setStartDate] = useState(dateKey(new Date()));
  return /*#__PURE__*/React.createElement("div", {
    onClick: onClose,
    style: {
      position: "fixed",
      inset: 0,
      background: "#00000099",
      zIndex: 50,
      display: "flex",
      alignItems: "flex-end",
      justifyContent: "center"
    }
  }, /*#__PURE__*/React.createElement("div", {
    onClick: e => e.stopPropagation(),
    style: {
      background: C.panel,
      borderTop: `1px solid ${C.borderLight}`,
      borderRadius: "18px 18px 0 0",
      width: "100%",
      maxWidth: 480,
      padding: "18px 16px 28px",
      boxShadow: "0 -8px 30px #00000066"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 40,
      height: 4,
      background: C.borderLight,
      borderRadius: 4,
      margin: "0 auto 14px"
    }
  }), mode === "choose" ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: FONT_DISPLAY,
      fontWeight: 700,
      fontSize: 16,
      color: C.text,
      marginBottom: 12,
      textAlign: "center"
    }
  }, "حط العسكري في إجازة"), PAYMENT_TYPES.map(p => /*#__PURE__*/React.createElement("button", {
    key: p.type,
    onClick: () => onPickPayment(p.type),
    style: {
      width: "100%",
      textAlign: "right",
      padding: "13px 14px",
      marginBottom: 6,
      borderRadius: 10,
      border: `1px solid ${C.border}`,
      background: "transparent",
      color: C.text,
      fontFamily: FONT_BODY,
      fontSize: 15,
      fontWeight: 600,
      cursor: "pointer"
    }
  }, p.label)), /*#__PURE__*/React.createElement("button", {
    onClick: () => setMode("exceptional"),
    style: {
      width: "100%",
      textAlign: "right",
      padding: "13px 14px",
      marginTop: 4,
      borderRadius: 10,
      border: `1px solid ${C.amber}55`,
      background: C.amberSoft,
      color: C.amber,
      fontFamily: FONT_BODY,
      fontSize: 15,
      fontWeight: 700,
      cursor: "pointer"
    }
  }, "إجازة استثنائية")) : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: FONT_DISPLAY,
      fontWeight: 700,
      fontSize: 16,
      color: C.text,
      marginBottom: 14,
      textAlign: "center"
    }
  }, "إجازة استثنائية"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: FONT_BODY,
      fontSize: 13,
      color: C.textMute,
      marginBottom: 6,
      fontWeight: 700
    }
  }, "تاريخ البداية"), /*#__PURE__*/React.createElement("input", {
    type: "date",
    value: startDate,
    onChange: e => setStartDate(e.target.value),
    style: {
      width: "100%",
      background: C.panelAlt,
      border: `1px solid ${C.border}`,
      borderRadius: 10,
      padding: "10px 12px",
      color: C.text,
      fontFamily: FONT_MONO,
      fontSize: 14,
      outline: "none",
      marginBottom: 16,
      colorScheme: "dark"
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: FONT_BODY,
      fontSize: 13,
      color: C.textMute,
      marginBottom: 6,
      fontWeight: 700
    }
  }, "عدد الأيام"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 14,
      marginBottom: 20
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setDays(d => Math.max(1, d - 1)),
    style: stepperBtnStyle
  }, "−"), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      textAlign: "center",
      fontFamily: FONT_MONO,
      fontSize: 20,
      fontWeight: 800,
      color: C.text
    }
  }, days), /*#__PURE__*/React.createElement("button", {
    onClick: () => setDays(d => Math.min(10, d + 1)),
    style: stepperBtnStyle
  }, "+")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setMode("choose"),
    style: ghostBtnStyle
  }, "رجوع"), /*#__PURE__*/React.createElement("button", {
    onClick: () => onConfirmExceptional(startDate, days),
    style: {
      ...ghostBtnStyle,
      flex: 1,
      background: C.olive,
      color: "#0e150d",
      border: "none",
      fontWeight: 800
    }
  }, "تأكيد")))));
}
const stepperBtnStyle = {
  width: 40,
  height: 40,
  borderRadius: 10,
  border: `1px solid ${C.border}`,
  background: C.panelAlt,
  color: C.text,
  fontSize: 20,
  fontWeight: 800,
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center"
};

// ---------- Soldiers manager ----------
function SoldiersPanel({
  soldiers,
  setSoldiers,
  onAddPaymentLeave,
  onAddExceptionalLeave,
  onEndLeaveNow
}) {
  const [open, setOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [editing, setEditing] = useState(null);
  const [editName, setEditName] = useState("");
  const [leaveSheetFor, setLeaveSheetFor] = useState(null);
  const addSoldier = () => {
    const name = newName.trim();
    if (!name) return;
    setSoldiers(prev => [...prev, {
      id: uid(),
      name,
      leaves: []
    }]);
    setNewName("");
  };
  const saveEdit = id => {
    const name = editName.trim();
    if (!name) {
      setEditing(null);
      return;
    }
    setSoldiers(prev => prev.map(s => s.id === id ? {
      ...s,
      name
    } : s));
    setEditing(null);
  };
  const deleteSoldier = id => {
    setSoldiers(prev => prev.filter(s => s.id !== id));
  };
  const todayKey = dateKey(new Date());
  const onLeaveCount = soldiers.filter(s => isOnLeave(s, todayKey)).length;
  const sorted = [...soldiers].sort((a, b) => (isOnLeave(a, todayKey) ? 0 : 1) - (isOnLeave(b, todayKey) ? 0 : 1));
  return /*#__PURE__*/React.createElement("div", {
    style: {
      background: C.panel,
      border: `1px solid ${C.border}`,
      borderRadius: 14,
      padding: 16,
      marginBottom: 16
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setOpen(v => !v),
    style: {
      width: "100%",
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      background: "transparent",
      border: "none",
      cursor: "pointer",
      padding: 0
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: FONT_DISPLAY,
      fontSize: 16,
      fontWeight: 800,
      color: C.text
    }
  }, "العساكر ", /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: FONT_MONO,
      color: C.textFaint,
      fontWeight: 400,
      fontSize: 13
    }
  }, "(", soldiers.length, ")"), onLeaveCount > 0 && /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: FONT_BODY,
      fontSize: 11.5,
      color: C.red,
      fontWeight: 700,
      marginRight: 8,
      background: C.redSoft,
      padding: "2px 8px",
      borderRadius: 999
    }
  }, onLeaveCount, " في إجازة")), /*#__PURE__*/React.createElement("span", {
    style: {
      color: C.textMute,
      fontSize: 18
    }
  }, open ? "−" : "+")), open && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("input", {
    value: newName,
    onChange: e => setNewName(e.target.value),
    onKeyDown: e => e.key === "Enter" && addSoldier(),
    placeholder: "اسم عسكري جديد",
    style: {
      flex: 1,
      background: C.panelAlt,
      border: `1px solid ${C.border}`,
      borderRadius: 10,
      padding: "10px 12px",
      color: C.text,
      fontFamily: FONT_BODY,
      fontSize: 14,
      outline: "none"
    }
  }), /*#__PURE__*/React.createElement("button", {
    onClick: addSoldier,
    style: {
      background: C.olive,
      color: "#0e150d",
      border: "none",
      borderRadius: 10,
      padding: "0 18px",
      fontFamily: FONT_DISPLAY,
      fontWeight: 800,
      fontSize: 14,
      cursor: "pointer"
    }
  }, "إضافة")), soldiers.length === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      color: C.textFaint,
      fontFamily: FONT_BODY,
      fontSize: 13.5,
      textAlign: "center",
      padding: "10px 0"
    }
  }, "لسه مفيش عساكر مضافين"), sorted.map(s => {
    const onLeaveNow = isOnLeave(s, todayKey);
    const activeLeave = onLeaveNow ? activeLeaveFor(s, todayKey) : null;
    const activeLeaveLabel = activeLeave ? PAYMENT_TYPES.find(p => p.type === activeLeave.type)?.label || "إجازة استثنائية" : null;
    return /*#__PURE__*/React.createElement("div", {
      key: s.id,
      style: {
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "9px 10px",
        borderRadius: 10,
        background: onLeaveNow ? C.redSoft : C.panelAlt,
        border: `1px solid ${onLeaveNow ? C.red + "55" : C.border}`,
        marginBottom: 6
      }
    }, editing === s.id ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("input", {
      value: editName,
      onChange: e => setEditName(e.target.value),
      onKeyDown: e => e.key === "Enter" && saveEdit(s.id),
      autoFocus: true,
      style: {
        flex: 1,
        background: C.panel,
        border: `1px solid ${C.amber}`,
        borderRadius: 8,
        padding: "7px 10px",
        color: C.text,
        fontFamily: FONT_BODY,
        fontSize: 14,
        outline: "none"
      }
    }), /*#__PURE__*/React.createElement("button", {
      onClick: () => saveEdit(s.id),
      style: iconBtnStyle(C.olive)
    }, "✓"), /*#__PURE__*/React.createElement("button", {
      onClick: () => setEditing(null),
      style: iconBtnStyle(C.textFaint)
    }, "✕")) : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("span", {
      style: {
        flex: 1,
        display: "flex",
        flexDirection: "column",
        gap: 1
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontFamily: FONT_BODY,
        fontSize: 14.5,
        color: onLeaveNow ? C.textMute : C.text,
        fontWeight: 600
      }
    }, s.name), onLeaveNow && /*#__PURE__*/React.createElement("span", {
      style: {
        fontFamily: FONT_BODY,
        fontSize: 11,
        color: C.red,
        fontWeight: 700
      }
    }, "في إجازة", activeLeaveLabel ? ` (${activeLeaveLabel})` : "")), /*#__PURE__*/React.createElement("button", {
      onClick: () => onLeaveNow ? onEndLeaveNow(s.id) : setLeaveSheetFor(s.id),
      style: {
        fontSize: 11.5,
        fontFamily: FONT_BODY,
        fontWeight: 700,
        border: `1px solid ${onLeaveNow ? C.olive : C.border}`,
        background: onLeaveNow ? C.oliveSoft : "transparent",
        color: onLeaveNow ? C.olive : C.textFaint,
        borderRadius: 8,
        padding: "6px 9px",
        cursor: "pointer",
        whiteSpace: "nowrap"
      }
    }, onLeaveNow ? "إنهاء الإجازة" : "إجازة"), /*#__PURE__*/React.createElement("button", {
      onClick: () => {
        setEditing(s.id);
        setEditName(s.name);
      },
      style: iconBtnStyle(C.textMute)
    }, "✎"), /*#__PURE__*/React.createElement("button", {
      onClick: () => deleteSoldier(s.id),
      style: iconBtnStyle(C.red)
    }, "🗑")));
  })), leaveSheetFor && /*#__PURE__*/React.createElement(LeaveTypeSheet, {
    onClose: () => setLeaveSheetFor(null),
    onPickPayment: type => {
      onAddPaymentLeave(leaveSheetFor, type);
      setLeaveSheetFor(null);
    },
    onConfirmExceptional: (startDate, days) => {
      onAddExceptionalLeave(leaveSheetFor, startDate, days);
      setLeaveSheetFor(null);
    }
  }));
}
function iconBtnStyle(color) {
  return {
    background: "transparent",
    border: "none",
    color,
    cursor: "pointer",
    fontSize: 15,
    padding: "4px 6px",
    lineHeight: 1
  };
}

// ---------- Live time strip (signature element) ----------
function DutyClock({
  now
}) {
  const h = now.getHours() + now.getMinutes() / 60;
  const hAdj = h < 7 ? h + 24 : h; // align to 7..31 scale
  const pct = (hAdj - 7) / 24 * 100;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 16
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: "relative",
      height: 8,
      borderRadius: 6,
      overflow: "hidden",
      display: "flex",
      border: `1px solid ${C.border}`
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 8,
      background: "#3d4f2e"
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 8,
      background: "#4a3a24"
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 8,
      background: "#2c3542"
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      top: -3,
      height: 14,
      width: 2,
      background: C.amber,
      borderRadius: 2,
      right: `${100 - pct}%`,
      boxShadow: `0 0 8px ${C.amber}`
    }
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "space-between",
      marginTop: 5,
      fontFamily: FONT_MONO,
      fontSize: 10.5,
      color: C.textFaint
    }
  }, /*#__PURE__*/React.createElement("span", null, "٧ص"), /*#__PURE__*/React.createElement("span", null, "٣م"), /*#__PURE__*/React.createElement("span", null, "١١م"), /*#__PURE__*/React.createElement("span", null, "٧ص")));
}

// ---------- Backup panel (export / import — offline app, no live sync) ----------
function BackupPanel({
  onExport,
  onImportFile,
  fileInputRef
}) {
  const [open, setOpen] = useState(false);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      background: C.panel,
      border: `1px solid ${C.border}`,
      borderRadius: 14,
      padding: 16,
      marginBottom: 16
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setOpen(v => !v),
    style: {
      width: "100%",
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      background: "transparent",
      border: "none",
      cursor: "pointer",
      padding: 0
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: FONT_DISPLAY,
      fontSize: 16,
      fontWeight: 800,
      color: C.text
    }
  }, "نسخة احتياطية ومشاركة"), /*#__PURE__*/React.createElement("span", {
    style: {
      color: C.textMute,
      fontSize: 18
    }
  }, open ? "−" : "+")), open && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: FONT_BODY,
      fontSize: 12.5,
      color: C.textFaint,
      lineHeight: 1.7,
      marginBottom: 10
    }
  }, "الأداة دي بتحفظ بياناتها على الجهاز ده بس (أوفلاين). عشان تاخد نسخة احتياطية أو تبعت بياناتك لحد تاني (زي صاحبك وقت الإجازة)، صدّر ملف JSON وابعته له، وهو يستورده عنده وهيلاقي نفس العساكر ونفس الجداول بالظبط."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: onExport,
    style: ghostBtnStyle
  }, "تصدير"), /*#__PURE__*/React.createElement("button", {
    onClick: () => fileInputRef.current?.click(),
    style: ghostBtnStyle
  }, "استيراد"), /*#__PURE__*/React.createElement("input", {
    ref: fileInputRef,
    type: "file",
    accept: "application/json",
    style: {
      display: "none"
    },
    onChange: e => {
      const file = e.target.files?.[0];
      if (file) onImportFile(file);
      e.target.value = "";
    }
  }))));
}
const ghostBtnStyle = {
  background: "transparent",
  color: C.text,
  border: `1px solid ${C.border}`,
  borderRadius: 10,
  padding: "10px 16px",
  fontFamily: FONT_BODY,
  fontWeight: 700,
  fontSize: 13.5,
  cursor: "pointer"
};

// ---------- Leaves panel (payment 1/2/3 + exceptional) ----------
function LeaveEntryRow({
  soldierName,
  leave,
  onDelta,
  onDeductFrom,
  onDelete
}) {
  const startD = parseDateKey(leave.startDate);
  const endD = parseDateKey(leave.endDate);
  const isPayment = leave.type !== "exceptional";
  return /*#__PURE__*/React.createElement("div", {
    style: {
      background: C.panelAlt,
      border: `1px solid ${C.border}`,
      borderRadius: 10,
      padding: 10,
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: FONT_BODY,
      fontSize: 14.5,
      fontWeight: 700,
      color: C.text
    }
  }, soldierName), /*#__PURE__*/React.createElement("button", {
    onClick: onDelete,
    style: iconBtnStyle(C.red)
  }, "🗑")), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: FONT_MONO,
      fontSize: 12,
      color: C.textFaint,
      marginBottom: 8,
      direction: "ltr",
      textAlign: "right"
    }
  }, fmtDayMonth(startD), " ← ", fmtDayMonth(endD)), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 10,
      flexWrap: "wrap"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => onDelta(-1),
    style: {
      ...stepperBtnStyle,
      width: 30,
      height: 30,
      fontSize: 16
    }
  }, "−"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: FONT_MONO,
      fontSize: 14,
      fontWeight: 800,
      color: C.text,
      minWidth: 18,
      textAlign: "center"
    }
  }, leave.days), /*#__PURE__*/React.createElement("button", {
    onClick: () => onDelta(1),
    style: {
      ...stepperBtnStyle,
      width: 30,
      height: 30,
      fontSize: 16
    }
  }, "+"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: FONT_BODY,
      fontSize: 11.5,
      color: C.textFaint
    }
  }, "يوم")), isPayment && onDeductFrom && /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 4,
      marginRight: "auto"
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => onDeductFrom("end"),
    style: {
      fontSize: 10.5,
      fontFamily: FONT_BODY,
      fontWeight: 700,
      padding: "5px 8px",
      borderRadius: 7,
      cursor: "pointer",
      border: `1px solid ${leave.deductFrom === "end" ? C.amber : C.border}`,
      background: leave.deductFrom === "end" ? C.amberSoft : "transparent",
      color: leave.deductFrom === "end" ? C.amber : C.textFaint
    }
  }, "خصم من الآخر"), /*#__PURE__*/React.createElement("button", {
    onClick: () => onDeductFrom("start"),
    style: {
      fontSize: 10.5,
      fontFamily: FONT_BODY,
      fontWeight: 700,
      padding: "5px 8px",
      borderRadius: 7,
      cursor: "pointer",
      border: `1px solid ${leave.deductFrom === "start" ? C.amber : C.border}`,
      background: leave.deductFrom === "start" ? C.amberSoft : "transparent",
      color: leave.deductFrom === "start" ? C.amber : C.textFaint
    }
  }, "خصم من الأول"))));
}
function AddExceptionalFlow({
  soldiers,
  onClose,
  onConfirm
}) {
  const [step, setStep] = useState("pick"); // 'pick' | 'form'
  const [soldierId, setSoldierId] = useState(null);
  const [days, setDays] = useState(3);
  const [startDate, setStartDate] = useState(dateKey(new Date()));
  if (step === "pick") {
    return /*#__PURE__*/React.createElement(PickerSheet, {
      title: "اختار العسكري",
      options: soldiers,
      selectedId: null,
      onSelect: id => {
        setSoldierId(id);
        setStep("form");
      },
      onClose: onClose
    });
  }
  return /*#__PURE__*/React.createElement("div", {
    onClick: onClose,
    style: {
      position: "fixed",
      inset: 0,
      background: "#00000099",
      zIndex: 50,
      display: "flex",
      alignItems: "flex-end",
      justifyContent: "center"
    }
  }, /*#__PURE__*/React.createElement("div", {
    onClick: e => e.stopPropagation(),
    style: {
      background: C.panel,
      borderTop: `1px solid ${C.borderLight}`,
      borderRadius: "18px 18px 0 0",
      width: "100%",
      maxWidth: 480,
      padding: "18px 16px 28px",
      boxShadow: "0 -8px 30px #00000066"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 40,
      height: 4,
      background: C.borderLight,
      borderRadius: 4,
      margin: "0 auto 14px"
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: FONT_DISPLAY,
      fontWeight: 700,
      fontSize: 16,
      color: C.text,
      marginBottom: 14,
      textAlign: "center"
    }
  }, soldiers.find(s => s.id === soldierId)?.name, " — إجازة استثنائية"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: FONT_BODY,
      fontSize: 13,
      color: C.textMute,
      marginBottom: 6,
      fontWeight: 700
    }
  }, "تاريخ البداية"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      marginBottom: 16
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setStartDate(d => dateKey(addDays(parseDateKey(d), -1))),
    style: {
      ...stepperBtnStyle,
      width: 36,
      height: 36,
      fontSize: 16
    }
  }, "‹"), /*#__PURE__*/React.createElement("input", {
    type: "date",
    value: startDate,
    onChange: e => setStartDate(e.target.value),
    style: {
      flex: 1,
      background: C.panelAlt,
      border: `1px solid ${C.border}`,
      borderRadius: 10,
      padding: "10px 12px",
      color: C.text,
      fontFamily: FONT_MONO,
      fontSize: 14,
      outline: "none",
      colorScheme: "dark",
      textAlign: "center"
    }
  }), /*#__PURE__*/React.createElement("button", {
    onClick: () => setStartDate(d => dateKey(addDays(parseDateKey(d), 1))),
    style: {
      ...stepperBtnStyle,
      width: 36,
      height: 36,
      fontSize: 16
    }
  }, "›")), /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center",
      fontFamily: FONT_BODY,
      fontSize: 12,
      color: C.textFaint,
      marginTop: -10,
      marginBottom: 16
    }
  }, WEEKDAY_NAMES[parseDateKey(startDate).getDay()], " ", fmtDayMonth(parseDateKey(startDate))), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: FONT_BODY,
      fontSize: 13,
      color: C.textMute,
      marginBottom: 6,
      fontWeight: 700
    }
  }, "عدد الأيام"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 14,
      marginBottom: 20
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setDays(d => Math.max(1, d - 1)),
    style: stepperBtnStyle
  }, "−"), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      textAlign: "center",
      fontFamily: FONT_MONO,
      fontSize: 20,
      fontWeight: 800,
      color: C.text
    }
  }, days), /*#__PURE__*/React.createElement("button", {
    onClick: () => setDays(d => Math.min(10, d + 1)),
    style: stepperBtnStyle
  }, "+")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setStep("pick"),
    style: ghostBtnStyle
  }, "رجوع"), /*#__PURE__*/React.createElement("button", {
    onClick: () => onConfirm(soldierId, startDate, days),
    style: {
      ...ghostBtnStyle,
      flex: 1,
      background: C.olive,
      color: "#0e150d",
      border: "none",
      fontWeight: 800
    }
  }, "تأكيد"))));
}
function LeavesPanel({
  soldiers,
  onAddPaymentLeave,
  onAddExceptionalLeave,
  onDeleteLeave,
  onRemovePaymentLeave,
  onAdjustPaymentDays,
  onSetDeductFrom,
  onAdjustExceptionalDays
}) {
  const [open, setOpen] = useState(false);
  const [viewDate, setViewDate] = useState(new Date());
  const [pickerForType, setPickerForType] = useState(null); // 'payment1' | 'payment2' | 'payment3'
  const [addingExceptional, setAddingExceptional] = useState(false);
  const [openSections, setOpenSections] = useState({
    payment1: false,
    payment2: false,
    payment3: false,
    exceptional: false
  });
  const toggleSection = key => setOpenSections(prev => ({
    ...prev,
    [key]: !prev[key]
  }));
  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const changeMonth = delta => setViewDate(d => new Date(d.getFullYear(), d.getMonth() + delta, 1));
  const exceptionalEntries = [];
  soldiers.forEach(s => {
    (s.leaves || []).forEach(l => {
      if (l.type === "exceptional") exceptionalEntries.push({
        soldier: s,
        leave: l
      });
    });
  });
  exceptionalEntries.sort((a, b) => a.leave.startDate < b.leave.startDate ? 1 : -1);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      background: C.panel,
      border: `1px solid ${C.border}`,
      borderRadius: 14,
      padding: 16,
      marginBottom: 16
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setOpen(v => !v),
    style: {
      width: "100%",
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      background: "transparent",
      border: "none",
      cursor: "pointer",
      padding: 0
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: FONT_DISPLAY,
      fontSize: 16,
      fontWeight: 800,
      color: C.text
    }
  }, "الإجازات"), /*#__PURE__*/React.createElement("span", {
    style: {
      color: C.textMute,
      fontSize: 18
    }
  }, open ? "−" : "+")), open && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      marginBottom: 16
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => changeMonth(-1),
    style: navBtnStyle
  }, "‹"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: FONT_DISPLAY,
      fontWeight: 800,
      fontSize: 15,
      color: C.text
    }
  }, MONTH_NAMES_SHORT[month], " ", year), /*#__PURE__*/React.createElement("button", {
    onClick: () => changeMonth(1),
    style: navBtnStyle
  }, "›")), PAYMENT_TYPES.map(p => {
    const {
      start,
      end
    } = paymentWindow(year, month, p.anchorDay);
    const entries = soldiers.filter(s => s.paymentLeave?.type === p.type).map(s => ({
      soldier: s,
      leave: {
        ...paymentLeaveRangeForMonth(s.paymentLeave, year, month),
        days: s.paymentLeave.days,
        deductFrom: s.paymentLeave.deductFrom,
        type: p.type
      }
    }));
    const eligibleSoldiers = soldiers.filter(s => s.paymentLeave?.type !== p.type);
    const sectionOpen = openSections[p.type];
    return /*#__PURE__*/React.createElement("div", {
      key: p.type,
      style: {
        marginBottom: 14,
        border: `1px solid ${C.border}`,
        borderRadius: 12,
        padding: 12
      }
    }, /*#__PURE__*/React.createElement("button", {
      onClick: () => toggleSection(p.type),
      style: {
        width: "100%",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        background: "transparent",
        border: "none",
        cursor: "pointer",
        padding: 0
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        display: "flex",
        alignItems: "baseline",
        gap: 8
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontFamily: FONT_DISPLAY,
        fontSize: 14.5,
        fontWeight: 800,
        color: C.text
      }
    }, p.label), entries.length > 0 && /*#__PURE__*/React.createElement("span", {
      style: {
        fontFamily: FONT_MONO,
        fontSize: 11,
        color: C.textFaint
      }
    }, "(", entries.length, ")")), /*#__PURE__*/React.createElement("span", {
      style: {
        display: "flex",
        alignItems: "center",
        gap: 10
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontFamily: FONT_MONO,
        fontSize: 11.5,
        color: C.textFaint,
        direction: "ltr"
      }
    }, fmtDayMonth(start), " ← ", fmtDayMonth(end)), /*#__PURE__*/React.createElement("span", {
      style: {
        color: C.textMute,
        fontSize: 16
      }
    }, sectionOpen ? "−" : "+"))), sectionOpen && /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: 10
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontFamily: FONT_BODY,
        fontSize: 11.5,
        color: C.textFaint,
        marginBottom: 8,
        lineHeight: 1.6
      }
    }, "العساكر هنا بيفضلوا في الدفعة دي كل شهر تلقائيًا، لحد ما تشيلهم أو تعدّلهم بنفسك."), entries.map(({
      soldier,
      leave
    }) => /*#__PURE__*/React.createElement(LeaveEntryRow, {
      key: soldier.id,
      soldierName: soldier.name,
      leave: leave,
      onDelta: d => onAdjustPaymentDays(soldier.id, d),
      onDeductFrom: dir => onSetDeductFrom(soldier.id, dir),
      onDelete: () => onRemovePaymentLeave(soldier.id)
    })), /*#__PURE__*/React.createElement("button", {
      onClick: () => setPickerForType(p.type),
      style: {
        ...ghostBtnStyle,
        width: "100%",
        padding: "9px 14px",
        fontSize: 13
      }
    }, "+ إضافة عسكري"), pickerForType === p.type && /*#__PURE__*/React.createElement(PickerSheet, {
      title: `إضافة عسكري — ${p.label}`,
      options: eligibleSoldiers,
      selectedId: null,
      onSelect: id => {
        onAddPaymentLeave(id, p.type);
        setPickerForType(null);
      },
      onClose: () => setPickerForType(null)
    })));
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      border: `1px solid ${C.border}`,
      borderRadius: 12,
      padding: 12
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => toggleSection("exceptional"),
    style: {
      width: "100%",
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      background: "transparent",
      border: "none",
      cursor: "pointer",
      padding: 0,
      marginBottom: openSections.exceptional ? 10 : 0
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: "flex",
      alignItems: "baseline",
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: FONT_DISPLAY,
      fontSize: 14.5,
      fontWeight: 800,
      color: C.text
    }
  }, "إجازات استثنائية"), exceptionalEntries.length > 0 && /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: FONT_MONO,
      fontSize: 11,
      color: C.textFaint
    }
  }, "(", exceptionalEntries.length, ")")), /*#__PURE__*/React.createElement("span", {
    style: {
      color: C.textMute,
      fontSize: 16
    }
  }, openSections.exceptional ? "−" : "+")), openSections.exceptional && /*#__PURE__*/React.createElement(React.Fragment, null, exceptionalEntries.length === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      color: C.textFaint,
      fontFamily: FONT_BODY,
      fontSize: 13,
      textAlign: "center",
      padding: "8px 0"
    }
  }, "مفيش إجازات استثنائية مسجّلة"), exceptionalEntries.map(({
    soldier,
    leave
  }) => /*#__PURE__*/React.createElement(LeaveEntryRow, {
    key: leave.id,
    soldierName: soldier.name,
    leave: leave,
    onDelta: d => onAdjustExceptionalDays(soldier.id, leave.id, d),
    onDelete: () => onDeleteLeave(soldier.id, leave.id)
  })), /*#__PURE__*/React.createElement("button", {
    onClick: () => setAddingExceptional(true),
    style: {
      ...ghostBtnStyle,
      width: "100%",
      padding: "9px 14px",
      fontSize: 13
    }
  }, "+ إضافة")), addingExceptional && /*#__PURE__*/React.createElement(AddExceptionalFlow, {
    soldiers: soldiers,
    onClose: () => setAddingExceptional(false),
    onConfirm: (soldierId, startDate, days) => {
      onAddExceptionalLeave(soldierId, startDate, days);
      setAddingExceptional(false);
    }
  }))));
}

// ---------- Main App ----------
function DutyRosterApp() {
  const [loading, setLoading] = useState(true);
  const [soldiers, setSoldiers] = useState([]);
  const [dateObj, setDateObj] = useState(new Date());
  const [dayData, setDayData] = useState(emptyDayData());
  const [now, setNow] = useState(new Date());
  const [historyTick, setHistoryTick] = useState(0);
  const saveTimer = useRef(null);
  const dayCache = useRef({});
  const fileInputRef = useRef(null);
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(t);
  }, []);
  const fetchDayRaw = useCallback(async d => {
    const key = dateKey(d);
    if (dayCache.current[key]) return dayCache.current[key];
    try {
      const res = await window.storage.get(`roster:${key}`);
      const data = res && res.value ? {
        ...emptyDayData(),
        ...JSON.parse(res.value)
      } : emptyDayData();
      dayCache.current[key] = data;
      return data;
    } catch {
      const data = emptyDayData();
      dayCache.current[key] = data;
      return data;
    }
  }, []);
  const loadDay = useCallback(async d => {
    const data = await fetchDayRaw(d);
    setDayData(data);
  }, [fetchDayRaw]);

  // Prefetch a window of previous days so the rest-hours calc can look far enough back
  const prefetchHistory = useCallback(async viewDate => {
    const jobs = [];
    for (let i = 1; i <= LOOKBACK_DAYS; i++) jobs.push(fetchDayRaw(addDays(viewDate, -i)));
    await Promise.all(jobs);
    setHistoryTick(t => t + 1);
  }, [fetchDayRaw]);

  // initial load
  useEffect(() => {
    (async () => {
      try {
        const res = await window.storage.get("soldiers");
        setSoldiers(res && res.value ? JSON.parse(res.value) : []);
      } catch {
        setSoldiers([]);
      }
      await loadDay(new Date());
      await prefetchHistory(new Date());
      setLoading(false);
    })();
    // eslint-disable-next-line
  }, []);

  // persist soldiers
  useEffect(() => {
    if (loading) return;
    window.storage.set("soldiers", JSON.stringify(soldiers)).catch(() => {});
  }, [soldiers, loading]);

  // persist day data (debounced) + keep cache in sync so gap calc sees fresh edits
  useEffect(() => {
    if (loading) return;
    const key = dateKey(dateObj);
    dayCache.current[key] = dayData;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      window.storage.set(`roster:${key}`, JSON.stringify(dayData)).catch(() => {});
    }, 300);
    // eslint-disable-next-line
  }, [dayData]);
  const changeDay = delta => {
    const nd = addDays(dateObj, delta);
    setDateObj(nd);
    loadDay(nd);
    prefetchHistory(nd);
  };
  const goToday = () => {
    const nd = new Date();
    setDateObj(nd);
    loadDay(nd);
    prefetchHistory(nd);
  };

  // ---- Export / Import (JSON backup, works regardless of sync mode) ----
  const exportData = () => {
    const rosters = {};
    Object.entries(dayCache.current).forEach(([key, data]) => {
      rosters[key] = data;
    });
    rosters[dateKey(dateObj)] = dayData;
    const payload = {
      exportedAt: new Date().toISOString(),
      soldiers,
      rosters
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json"
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `duty-roster-${dateKey(new Date())}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };
  const importData = file => {
    const reader = new FileReader();
    reader.onload = async e => {
      try {
        const parsed = JSON.parse(e.target.result);
        if (Array.isArray(parsed.soldiers)) setSoldiers(parsed.soldiers);
        if (parsed.rosters && typeof parsed.rosters === "object") {
          Object.entries(parsed.rosters).forEach(([key, data]) => {
            dayCache.current[key] = {
              ...emptyDayData(),
              ...data
            };
          });
          await Promise.all(Object.entries(parsed.rosters).map(([key, data]) => window.storage.set(`roster:${key}`, JSON.stringify(data))));
        }
        await loadDay(dateObj);
        setHistoryTick(t => t + 1);
      } catch {
        // ignore malformed file
      }
    };
    reader.readAsText(file);
  };
  const activeSoldiers = soldiers.filter(s => !isOnLeave(s, dateKey(dateObj)));

  // ---- Leave management (payment 1/2/3 + exceptional) ----
  const addPaymentLeave = (soldierId, type) => {
    setSoldiers(prev => prev.map(s => s.id === soldierId ? {
      ...s,
      paymentLeave: {
        type,
        days: 10,
        deductFrom: "end"
      }
    } : s));
  };
  const addExceptionalLeave = (soldierId, startDateKeyStr, days) => {
    const endDateKeyStr = dateKey(addDays(parseDateKey(startDateKeyStr), days - 1));
    setSoldiers(prev => prev.map(s => {
      if (s.id !== soldierId) return s;
      const newLeave = {
        id: uid(),
        type: "exceptional",
        days,
        startDate: startDateKeyStr,
        endDate: endDateKeyStr
      };
      return {
        ...s,
        leaves: [...(s.leaves || []), newLeave]
      };
    }));
  };
  const endLeaveNow = soldierId => {
    const todayK = dateKey(new Date());
    const yesterdayK = dateKey(addDays(new Date(), -1));
    setSoldiers(prev => prev.map(s => {
      if (s.id !== soldierId) return s;
      const activeExceptional = (s.leaves || []).find(l => todayK >= l.startDate && todayK <= l.endDate);
      if (activeExceptional) {
        const leaves = (s.leaves || []).map(l => {
          if (l.id !== activeExceptional.id) return l;
          // started today and being cancelled right away = it never really happened
          if (l.startDate === todayK) return null;
          return {
            ...l,
            endDate: yesterdayK
          };
        }).filter(Boolean);
        return {
          ...s,
          leaves
        };
      }
      // on a payment-group leave today: ending it now means leaving that group entirely
      if (s.paymentLeave && isOnPaymentLeaveOn(s.paymentLeave, todayK)) {
        return {
          ...s,
          paymentLeave: null
        };
      }
      return s;
    }));
  };
  const deleteLeave = (soldierId, leaveId) => {
    setSoldiers(prev => prev.map(s => s.id === soldierId ? {
      ...s,
      leaves: (s.leaves || []).filter(l => l.id !== leaveId)
    } : s));
  };
  const removePaymentLeave = soldierId => {
    setSoldiers(prev => prev.map(s => s.id === soldierId ? {
      ...s,
      paymentLeave: null
    } : s));
  };
  const adjustPaymentDays = (soldierId, delta) => {
    setSoldiers(prev => prev.map(s => {
      if (s.id !== soldierId || !s.paymentLeave) return s;
      const newDays = Math.max(1, Math.min(10, s.paymentLeave.days + delta));
      return {
        ...s,
        paymentLeave: {
          ...s.paymentLeave,
          days: newDays
        }
      };
    }));
  };
  const setLeaveDeductFrom = (soldierId, deductFrom) => {
    setSoldiers(prev => prev.map(s => s.id === soldierId && s.paymentLeave ? {
      ...s,
      paymentLeave: {
        ...s.paymentLeave,
        deductFrom
      }
    } : s));
  };
  const adjustExceptionalDays = (soldierId, leaveId, delta) => {
    setSoldiers(prev => prev.map(s => {
      if (s.id !== soldierId) return s;
      const leaves = (s.leaves || []).map(l => {
        if (l.id !== leaveId) return l;
        const newDays = Math.max(1, Math.min(10, l.days + delta));
        const endDate = dateKey(addDays(parseDateKey(l.startDate), newDays - 1));
        return {
          ...l,
          days: newDays,
          endDate
        };
      });
      return {
        ...s,
        leaves
      };
    }));
  };
  const isSameDay = (a, b) => dateKey(a) === dateKey(b);
  const isTodayView = isSameDay(dateObj, now);
  const currentShiftId = (() => {
    const h = now.getHours() + now.getMinutes() / 60;
    const hAdj = h < 7 ? h + 24 : h;
    if (hAdj < 15) return "morning";
    if (hAdj < 23) return "afternoon";
    return "night";
  })();

  // getDayData used by computeGaps: current viewed day comes from fresh state, others from cache
  const getDayDataForCalc = useCallback(d => {
    if (dateKey(d) === dateKey(dateObj)) return dayData;
    return dayCache.current[dateKey(d)] || emptyDayData();
  }, [dateObj, dayData]);
  if (loading) {
    return /*#__PURE__*/React.createElement("div", {
      style: {
        minHeight: "100vh",
        background: C.bg,
        display: "flex",
        alignItems: "center",
        justifyContent: "center"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        color: C.textMute,
        fontFamily: FONT_BODY
      }
    }, "جارِ التحميل…"));
  }
  return /*#__PURE__*/React.createElement("div", {
    dir: "rtl",
    style: {
      minHeight: "100vh",
      background: C.bg,
      fontFamily: FONT_BODY
    }
  }, /*#__PURE__*/React.createElement("link", {
    rel: "preconnect",
    href: "https://fonts.googleapis.com"
  }), /*#__PURE__*/React.createElement("link", {
    href: "https://fonts.googleapis.com/css2?family=Cairo:wght@700;800;900&family=Tajawal:wght@400;500;700;900&family=JetBrains+Mono:wght@400;600&display=swap",
    rel: "stylesheet"
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 520,
      margin: "0 auto",
      padding: "22px 16px 60px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 18
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: FONT_DISPLAY,
      fontWeight: 900,
      fontSize: 22,
      color: C.amber,
      letterSpacing: 0.3
    }
  }, "جدول الخدمات"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: FONT_BODY,
      fontSize: 13,
      color: C.textFaint,
      marginTop: 2
    }
  }, "تنظيم خدمات الأبراج والسيارة يوميًا")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      background: C.panel,
      border: `1px solid ${C.border}`,
      borderRadius: 14,
      padding: "10px 12px",
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => changeDay(-1),
    style: navBtnStyle
  }, "‹"), /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center",
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: FONT_DISPLAY,
      fontWeight: 800,
      fontSize: 15,
      color: C.text
    }
  }, fmtDateArabic(dateObj)), !isTodayView && /*#__PURE__*/React.createElement("button", {
    onClick: goToday,
    style: {
      background: "none",
      border: "none",
      color: C.amber,
      fontFamily: FONT_BODY,
      fontSize: 12,
      cursor: "pointer",
      marginTop: 2,
      padding: 0
    }
  }, "الرجوع لليوم")), /*#__PURE__*/React.createElement("button", {
    onClick: () => changeDay(1),
    style: navBtnStyle
  }, "›")), isTodayView && /*#__PURE__*/React.createElement(DutyClock, {
    now: now
  }), /*#__PURE__*/React.createElement(BackupPanel, {
    onExport: exportData,
    onImportFile: importData,
    fileInputRef: fileInputRef
  }), /*#__PURE__*/React.createElement(SoldiersPanel, {
    soldiers: soldiers,
    setSoldiers: setSoldiers,
    onAddPaymentLeave: addPaymentLeave,
    onAddExceptionalLeave: addExceptionalLeave,
    onEndLeaveNow: endLeaveNow
  }), /*#__PURE__*/React.createElement(LeavesPanel, {
    soldiers: soldiers,
    onAddPaymentLeave: addPaymentLeave,
    onAddExceptionalLeave: addExceptionalLeave,
    onDeleteLeave: deleteLeave,
    onRemovePaymentLeave: removePaymentLeave,
    onAdjustPaymentDays: adjustPaymentDays,
    onSetDeductFrom: setLeaveDeductFrom,
    onAdjustExceptionalDays: adjustExceptionalDays
  }), SHIFTS.map(shift => {
    const gaps = computeGaps(dateObj, shift.id, activeSoldiers, getDayDataForCalc);
    const isPast = now.getTime() > shiftEndDate(dateObj, shift.id).getTime();
    return /*#__PURE__*/React.createElement(ShiftCard, {
      key: shift.id + "-" + historyTick,
      shift: shift,
      dateObj: dateObj,
      data: dayData[shift.id],
      fullDayData: dayData,
      soldiers: activeSoldiers,
      allSoldiers: soldiers,
      isActive: isTodayView && currentShiftId === shift.id,
      isPast: isPast,
      onUpdate: newData => setDayData(prev => ({
        ...prev,
        [shift.id]: newData
      })),
      gaps: gaps
    });
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center",
      color: C.textFaint,
      fontFamily: FONT_MONO,
      fontSize: 11,
      marginTop: 20
    }
  }, "البيانات بتتحفظ تلقائيًا على الجهاز ده")));
}
const navBtnStyle = {
  background: C.panelAlt,
  border: `1px solid ${C.border}`,
  color: C.text,
  width: 34,
  height: 34,
  borderRadius: 9,
  fontSize: 18,
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center"
};

// ---------- Mount ----------
const rootEl = document.getElementById("root");
ReactDOM.createRoot(rootEl).render(/*#__PURE__*/React.createElement(DutyRosterApp, null));