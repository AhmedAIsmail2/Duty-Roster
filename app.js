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
      carEnabled: true
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

// ---------- Picker (tap-to-select sheet) ----------
function PickerSheet({
  title,
  options,
  selectedId,
  onSelect,
  onClose,
  restHours = {},
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
    const hrs = restHours[o.id];
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
        border: `1px solid ${isSelected ? C.olive : hrs ? C.amber + "55" : C.border}`,
        background: isSelected ? C.oliveSoft : hrs ? C.amberSoft : "transparent",
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
    }, hrs > 0 && /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 11,
        fontFamily: FONT_MONO,
        color: C.amber,
        fontWeight: 700
      }
    }, "راحة ", hrs, " ساعة"), tower && /*#__PURE__*/React.createElement("span", {
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
  restHours = {},
  lastTower = {}
}) {
  const [open, setOpen] = useState(false);
  const soldierName = allSoldiers.find(s => s.id === selectedId)?.name;
  const selectedHrs = selectedId && restHours[selectedId];
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
  }, soldierName || "بدون تعيين"), selectedHrs > 0 && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 10.5,
      fontFamily: FONT_MONO,
      color: C.amber,
      fontWeight: 700
    }
  }, "راحة ", selectedHrs, " ساعة"))), open && /*#__PURE__*/React.createElement(PickerSheet, {
    title: label,
    options: options,
    selectedId: selectedId,
    onSelect: onChange,
    onClose: () => setOpen(false),
    restHours: restHours,
    lastTower: lastTower
  }));
}

// ---------- Shift Card ----------
function ShiftCard({
  shift,
  dateObj,
  data,
  soldiers,
  allSoldiers,
  onUpdate,
  isActive,
  gaps
}) {
  const positions = positionsForShift(shift.id, dateObj);
  const canHaveCar = true; // car service can now be toggled in any shift, including morning

  // gap === 1 -> mandatory 8h rest right after their last shift: fully hidden
  const hiddenByRest = new Set(soldiers.filter(s => gaps[s.id]?.gap === 1).map(s => s.id));
  // gap >= 3 -> still resting beyond their normal return point: shown, labeled with cumulative hours
  const restHours = {};
  const lastTower = {};
  soldiers.forEach(s => {
    const info = gaps[s.id];
    if (!info) return;
    if (info.gap >= 3) restHours[s.id] = (info.gap - 1) * 8;
    lastTower[s.id] = lastTowerLabel(info);
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
      overflow: "hidden"
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
      color: isActive ? C.amber : C.text
    }
  }, shift.label, isActive && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      marginRight: 8,
      fontFamily: FONT_MONO,
      color: C.amber
    }
  }, "● جارية الآن"))), /*#__PURE__*/React.createElement("div", {
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
    restHours: restHours,
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
    restHours: restHours,
    lastTower: lastTower
  })));
}

// ---------- Soldiers manager ----------
function SoldiersPanel({
  soldiers,
  setSoldiers
}) {
  const [open, setOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [editing, setEditing] = useState(null);
  const [editName, setEditName] = useState("");
  const addSoldier = () => {
    const name = newName.trim();
    if (!name) return;
    setSoldiers(prev => [...prev, {
      id: uid(),
      name,
      onLeave: false
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
  const toggleLeave = id => {
    setSoldiers(prev => prev.map(s => s.id === id ? {
      ...s,
      onLeave: !s.onLeave
    } : s));
  };
  const onLeaveCount = soldiers.filter(s => s.onLeave).length;
  const sorted = [...soldiers].sort((a, b) => !!a.onLeave - !!b.onLeave);
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
  }, "لسه مفيش عساكر مضافين"), sorted.map(s => /*#__PURE__*/React.createElement("div", {
    key: s.id,
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      padding: "9px 10px",
      borderRadius: 10,
      background: s.onLeave ? C.redSoft : C.panelAlt,
      border: `1px solid ${s.onLeave ? C.red + "55" : C.border}`,
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
      color: s.onLeave ? C.textMute : C.text,
      fontWeight: 600
    }
  }, s.name), s.onLeave && /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: FONT_BODY,
      fontSize: 11,
      color: C.red,
      fontWeight: 700
    }
  }, "في إجازة")), /*#__PURE__*/React.createElement("button", {
    onClick: () => toggleLeave(s.id),
    style: {
      fontSize: 11.5,
      fontFamily: FONT_BODY,
      fontWeight: 700,
      border: `1px solid ${s.onLeave ? C.olive : C.border}`,
      background: s.onLeave ? C.oliveSoft : "transparent",
      color: s.onLeave ? C.olive : C.textFaint,
      borderRadius: 8,
      padding: "6px 9px",
      cursor: "pointer",
      whiteSpace: "nowrap"
    }
  }, s.onLeave ? "إنهاء الإجازة" : "إجازة"), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      setEditing(s.id);
      setEditName(s.name);
    },
    style: iconBtnStyle(C.textMute)
  }, "✎"), /*#__PURE__*/React.createElement("button", {
    onClick: () => deleteSoldier(s.id),
    style: iconBtnStyle(C.red)
  }, "🗑"))))));
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

  // ---- Export / Import (JSON backup — how you hand data off to someone else offline) ----
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
  const activeSoldiers = soldiers.filter(s => !s.onLeave);
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
    setSoldiers: setSoldiers
  }), SHIFTS.map(shift => {
    const gaps = computeGaps(dateObj, shift.id, activeSoldiers, getDayDataForCalc);
    return /*#__PURE__*/React.createElement(ShiftCard, {
      key: shift.id + "-" + historyTick,
      shift: shift,
      dateObj: dateObj,
      data: dayData[shift.id],
      soldiers: activeSoldiers,
      allSoldiers: soldiers,
      isActive: isTodayView && currentShiftId === shift.id,
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