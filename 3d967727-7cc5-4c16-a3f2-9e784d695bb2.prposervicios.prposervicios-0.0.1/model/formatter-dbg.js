sap.ui.define([], function () {
  "use strict";

  function yyyymmddToDate(date) {
    if (!date) return "";
    const stringDate = String(date);
    if (stringDate.length !== 8) return stringDate;
    return (
      stringDate.slice(0, 4) +
      "-" +
      stringDate.slice(4, 6) +
      "-" +
      stringDate.slice(6, 8)
    );
  }

  function statusText(simState, simErr) {
    if (simState === "PENDING") return "Simulating...";
    if (simState !== "DONE") return "";       
    return simErr ? "Sim Error" : "OK";
  }

  function statusState(simState, simErr) {
    if (simState === "PENDING") return "Warning"; 
    if (simState !== "DONE") return "None";      
    return simErr ? "Error" : "Success";
  }

  function truncate80(text) {
    if (!text) return "";
    const s = String(text);
    return s.length > 10 ? s.slice(0, 10) + "…" : s;
  }

  function hasMoreThan80(text) {
    return !!text && String(text).length > 10;
  }

  return {
    yyyymmddToDate,
    statusText,
    statusState,
    truncate80,
    hasMoreThan80
  };
});