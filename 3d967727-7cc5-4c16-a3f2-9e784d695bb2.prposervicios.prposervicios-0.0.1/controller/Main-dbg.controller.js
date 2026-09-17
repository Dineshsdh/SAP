sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/m/MessageToast",
  "sap/m/MessageBox",
  "sap/ui/model/json/JSONModel",
  "sap/ui/model/Filter",
  "sap/ui/model/FilterOperator",
  "sap/ui/model/FilterType",
  "sap/ui/export/Spreadsheet",
  "prposervicios/model/formatter",
  "sap/ui/comp/variants/VariantItem",
  "sap/m/DynamicDateRange",
  "sap/m/DynamicDateUtil"
], function (Controller, MessageToast, MessageBox, JSONModel, Filter, FilterOperator, FilterType, Spreadsheet, formatter, VariantItem, DynamicDateRange, DynamicDateUtil) {
  "use strict";

  return Controller.extend("prposervicios.controller.Main", {
    formatter: formatter,
    _busyCount: 0,
    _startupApplied: false,
    _startupKpiType: null,

    onInit: function () {
      this._simCache = new Map();
      this._busyCount = 0;
      this._poUserTriggered = false;
      this._poBound = false;
      this._simQueue = Promise.resolve();
      this._suspendAutoSim = true;

      var oViewModel = new JSONModel({
        selectedCount: 0,
        pageSize: 10,
        pageIndex: 0,     
        pageCount: 1,   
        totalCount: 0, 
        visibleRowCount: 10,

        poPageSize: 10,
        poVisibleRowCount: 10,

        busy: false,
        busySim: false,
        simStatusFilter: "ALL",
        prStatusFilter: "ALL",
        poGRNStatusKey: "",
        poOutputStatusKey: "",
        selectedCountPO: 0
      });
      this.getView().setModel(oViewModel, "ui");
      this._applyPRPageSize(oViewModel.getProperty("/pageSize"));
      
      this.getView().setModel(new JSONModel({
        rows: [],
        allRows: [],
        filteredRows: [],
        loadedCount: 0,
        totalCount: 0
      }), "prLocal");

      this.getView().setModel(new sap.ui.model.json.JSONModel({
        allRows: [],
        filteredRows: [],
        rows: []
      }), "poLocal");

      this.getView().setModel(new JSONModel({
        grnStatus: [],        
        outputStatus: []      
      }), "poVH");

      try {
        var oComp = this.getOwnerComponent && this.getOwnerComponent();
        var mStartup = oComp && oComp.getComponentData && oComp.getComponentData().startupParameters;

        if (mStartup && mStartup.kpiType && mStartup.kpiType[0]) {
          this._startupKpiType = String(mStartup.kpiType[0]).trim();
        }

        if (!this._startupKpiType) {
          var sHash = sap.ui.core.routing.HashChanger.getInstance().getHash() || "";
          var idx = sHash.indexOf("?");
          if (idx >= 0) {
            var qs = sHash.slice(idx + 1);
            var params = new URLSearchParams(qs);
            this._startupKpiType = (params.get("kpiType") || "").trim();
          }
        }
      } catch (e) {
        // ignore
      }

      this.getView().addEventDelegate({
        onAfterRendering: async () => {
          if (this._didInitAfterRender) return;
          this._didInitAfterRender = true;

          this._suspendAutoSim = true;

          await this._loadPRsToLocal();
          await this._applyStartupKpiType();
          await this._loadPRVariantsAndApply();

          this._suspendAutoSim = false;

          const sSim = this.getView().getModel("ui").getProperty("/simStatusFilter") || "ALL";
          if (sSim === "ALL") {
            await this._simulateVisibleRows();
          }
        }
      });
    },

    _loadPRVariantsAndApply: async function () {
      if (this._prVariantsLoaded) return;
      this._prVariantsLoaded = true;

      try {
        await this._loadPRVariants();
      } catch (e) {
        console.error("load variants failed", e);
      }
    },

    onTabSelect: async function (oEvent) {
      const sKey = oEvent.getParameter("key");
      if (sKey !== "PO") return;
      
      this._poUserTriggered = false;

      const oUi = this.getView().getModel("ui");
      oUi.setProperty("/poVisibleRowCount", 1); 

      const oTable = this.byId("poTable");
      oTable?.setBusy(true);
      try {
        if (!this._poVariantsLoaded) {
          this._poVariantsLoaded = true;
          await this._loadPOVariants();  
        } else {
          const oDRS = this.byId("poCreatedOn");
          if (!oDRS?.getDateValue?.() || !oDRS?.getSecondDateValue?.()) {
            this._setDefaultLast30DaysPO();
          }

          await this._rebindPO();
          await this._updatePOVisibleRowCount();
        }
      } finally {
        oTable?.setBusy(false);
      }
    },

    _makeKey: function (r) {
      return `${r.PurReqNumber}:${r.PurReqItemNo}`;
    },

    _snapshotSimToCache: function () {
      const aAll = this.getView().getModel("prLocal").getProperty("/allRows") || [];
      aAll.forEach(r => {
        const key = this._makeKey(r);
        this._simCache.set(key, {
          SimulationState: r.SimulationState,
          SimulationError: !!r.SimulationError,
          SimulationWarn:  !!r.SimulationWarn,
          SimulationLogs:  Array.isArray(r.SimulationLogs) ? r.SimulationLogs.slice() : []
        });
      });
    },

    _busyOn: function (sText) {
      if (!Number.isFinite(this._busyCount)) this._busyCount = 0;   
      this._busyCount++;

      const oUi = this.getView().getModel("ui");
      oUi.setProperty("/busyText", sText || "Loading...");
      oUi.setProperty("/busy", true);
    },

    _busyOff: function () {
      if (!Number.isFinite(this._busyCount)) this._busyCount = 0;   
      this._busyCount = Math.max(0, this._busyCount - 1);

      if (this._busyCount === 0) {
        const oUi = this.getView().getModel("ui");
        oUi.setProperty("/busy", false);
        oUi.setProperty("/busyText", "");
      }
    },

    _setupAutoSimulation: function () {
      this._autoSimSetup = true;
    },

    _recalcPRPager: function () {
      var oUi = this.getView().getModel("ui");
      var oPR = this.getView().getModel("prLocal");

      var vPageSize = oUi.getProperty("/pageSize") || 10; // number o "ALL"
      var aBase = oPR.getProperty("/filteredRows") || [];
      var iTotal = aBase.length;

      // ALL = sin paginación
      if (vPageSize === "ALL") {
        oUi.setProperty("/totalCount", iTotal);
        oUi.setProperty("/pageCount", 1);
        oUi.setProperty("/pageIndex", 0);
        return;
      }

      var iPageCount = Math.max(1, Math.ceil(iTotal / vPageSize));
      var iPageIndex = oUi.getProperty("/pageIndex") || 0;
      if (iPageIndex > iPageCount - 1) iPageIndex = iPageCount - 1;

      oUi.setProperty("/totalCount", iTotal);
      oUi.setProperty("/pageCount", iPageCount);
      oUi.setProperty("/pageIndex", iPageIndex);
    },

    _setPRPage: function (iTargetIndex, mOpts) {
      mOpts = mOpts || {};
      const bSkipAutoSim = !!mOpts.skipAutoSim;

      var oTable = this.byId("prTable");
      var oUi = this.getView().getModel("ui");
      var oPR = this.getView().getModel("prLocal");

      var aBase = oPR.getProperty("/filteredRows") || [];
      var vPageSize = oUi.getProperty("/pageSize") || 10;

      if (vPageSize === "ALL") {
        oUi.setProperty("/pageIndex", 0);

        oPR.setProperty("/rows", aBase.slice());
        oPR.setProperty("/totalCount", aBase.length);
        oPR.setProperty("/loadedCount", aBase.length);

        oUi.setProperty("/visibleRowCount", Math.max(1, aBase.length));

        if (oTable) oTable.setFirstVisibleRow(0);

        oUi.setProperty("/selectedCount", 0);
        if (oTable) oTable.clearSelection();

        if (!bSkipAutoSim && !this._suspendAutoSim) {
          this._simulateVisibleRows();
        }

        return;
      }

      var iPageCount = Math.max(1, Math.ceil(aBase.length / vPageSize));
      var iIndex = Math.max(0, Math.min(iTargetIndex, iPageCount - 1));
      oUi.setProperty("/pageIndex", iIndex);

      var iStart = iIndex * vPageSize;
      var iEnd = iStart + vPageSize;

      var aPageRows = aBase.slice(iStart, iEnd);
      oPR.setProperty("/rows", aPageRows);
      oPR.setProperty("/totalCount", aBase.length);
      oPR.setProperty("/loadedCount", Math.min(iEnd, aBase.length));

      oUi.setProperty("/visibleRowCount", Math.max(1, Math.min(vPageSize, aPageRows.length)));

      if (oTable) oTable.setFirstVisibleRow(0);

      oUi.setProperty("/selectedCount", 0);
      if (oTable) oTable.clearSelection();

      if (!bSkipAutoSim && !this._suspendAutoSim) {
        this._simulateVisibleRows();
      }
    },

    _loadPRsToLocal: async function (mOpts) {
      mOpts = mOpts || {};
      const bSkipBuildFilterBar = !!mOpts.skipBuildFilterBar;
      const bResetPage = (mOpts.resetPage !== false);

      const oView = this.getView();
      this._busyOn("Loading PR data...");

      try {
        const oODataModel = oView.getModel(); 
        const oListBinding = oODataModel.bindList("/PRdatas");
        const aCtx = await oListBinding.requestContexts(0, 10000); 

        let aRows = aCtx.map(c => c.getObject()).map(r => {
          const key = `${r.PurReqNumber}:${r.PurReqItemNo}`;
          const cached = this._simCache.get(key);
          return {
            ...r,
            SimulationState: cached?.SimulationState || "NEW",
            SimulationError: cached?.SimulationError || false,
            SimulationWarn:  cached?.SimulationWarn  || false,
            SimulationLogs:  cached?.SimulationLogs  ? cached.SimulationLogs.slice() : []
          };
        });

        const oPR = this.getView().getModel("prLocal");
        oPR.setProperty("/allRows", aRows);      
        oPR.setProperty("/totalCount", aRows.length);

        if (!bSkipBuildFilterBar) {
          this._buildPRFilterBarFromData(aRows);
        }

        this._applyPRFiltersFromFilterBar({ resetPage: bResetPage });

      } catch (e) {
        console.error("Failed loading PRs to local model:", e);
        sap.m.MessageToast.show("Failed loading PRs: " + (e.message || e));
        oView.getModel("prLocal")?.setProperty("/rows", []);
      } finally{
        this._busyOff();
      }
    },

    onSimStatusChange: function () {
      this._applyPRFiltersFromFilterBar(); 
    },

    _isSimError: function (oRow) {
      return oRow.SimulationState === "DONE" && !!oRow.SimulationError;
    },

    _isSimSuccess: function (oRow) {
      return oRow.SimulationState === "DONE" && !oRow.SimulationError;
    },

    _buildPRFilterBarFromData: function (aRows) {
      const oFB = this.byId("prFilterBar");
      if (!oFB) return;

      if (this._prFiltersBuilt) return;
      this._prFiltersBuilt = true;

      const aExclude = ["UserName", "DeletionIndic", "UnDeletionIndic", "MaterialDesc", "SupplierNo"];

      const aDefaultVisible = [
        "SimStatus",
        "PRStatus",
        "PurReqNumber",
        "MaterialNo",
        "PurchasingOrg",
        "MrpController"
      ];

      const aForced = []; 

      const oSample = (aRows && aRows.length) ? aRows[0] : {};
      const aFields = Array.from(new Set([
        ...Object.keys(oSample || {}),
        ...aForced
      ])).filter(f => !aExclude.includes(f));

      aFields.sort((a, b) => {
        const ia = aDefaultVisible.includes(a) ? 0 : 1;
        const ib = aDefaultVisible.includes(b) ? 0 : 1;
        if (ia !== ib) return ia - ib;
        return a.localeCompare(b);
      });

      const isDateField = (sField) => ["DocumentDate", "ReleaseDate", "DeliveryDate"].includes(sField);

      aFields.forEach((sField) => {
        const bVisible = aDefaultVisible.includes(sField);

        const oControl = isDateField(sField)
          ? new sap.m.DateRangeSelection({
              width: "18rem",
              placeholder: "From - To",
              change: this.onPRFilterImmediateChange.bind(this)
            })
          : new sap.m.Input({
              width: "14rem",
              placeholder: "Enter " + this._labelForPRField(sField),
              liveChange: this.onPRFilterImmediateChange.bind(this)
            });
        
        oControl.data("field", sField);

        const oFGI = new sap.ui.comp.filterbar.FilterGroupItem({
          name: sField,
          label: this._labelForPRField(sField),
          groupName: "Group1",
          visibleInFilterBar: bVisible,
          control: oControl
        });

        oFB.addFilterGroupItem(oFGI);
      });
    },

    _formatPRLogsForExport: function (aLogs) {
      if (!Array.isArray(aLogs) || aLogs.length === 0) return "";

      const aErr = aLogs.filter(l => String(l?.type || "").toUpperCase() === "E");
      if (!aErr.length) return "";

      return aErr
        .map(l => {
          const msg = l?.text || l?.message || "";
          return `[E] ${msg}`;
        })
        .join("\n");
    },

    _formatPRStatusForExport: function (r) {
      return (r && r.DeletionIndic === "X") ? "Deleted" : "Active";
    },

    _formatSimStatusForExport: function (r) {
      // Usá el mismo formatter que en la tabla (ideal para que coincida 1:1)
      return this.formatter.statusText(
        r?.SimulationState,
        r?.SimulationError,
        r?.SimulationWarn
      );
    },

    _ensureRowsSimulatedForExport: async function (aRows) {
      if (!Array.isArray(aRows) || !aRows.length) return;

      this._simBusy = true;
      this.getView().getModel("ui").setProperty("/busySim", true);

      try {
        for (const r of aRows) {
          const oFull = this._buildPRToPOItem(r);

          try {
            const aReturn = await this._executeCatalogAction("prSimulateMultiple", {
              Items: [oFull]
            });

            const aLogs = (aReturn || []).map(m => ({
              type: m.MsgType || "I",
              text: m.MsgText || ""
            }));

            const bError = aLogs.some(l => l.type === "E" || l.type === "A");
            const bWarn  = !bError && aLogs.some(l => l.type === "W");

            r.SimulationState = "DONE";
            r.SimulationError = bError;
            r.SimulationWarn  = bWarn;
            r.SimulationLogs  = aLogs;

          } catch (e) {
            r.SimulationState = "DONE";
            r.SimulationError = true;
            r.SimulationWarn  = false;
            r.SimulationLogs  = [{
              type: "E",
              text: "Simulation failed: " + (e?.message || e)
            }];
          }
        }

        this.getView().getModel("prLocal")?.refresh(true);

      } finally {
        this.getView().getModel("ui").setProperty("/busySim", false);
        this._simBusy = false;
      }
    },

    onExportPRsToExcel: async function () {
      const oTable = this.byId("prTable");
      if (!oTable) return;

      const oPR = this.getView().getModel("prLocal");

      const aAllRows = (oPR && oPR.getProperty("/allRows")) || [];
      const aFiltered = oPR.getProperty("/filteredRows") || [];

      if (!aAllRows.length) {
        sap.m.MessageToast.show("No data to export.");
        return;
      }

      const aSelIdx = (oTable.getSelectedIndices && oTable.getSelectedIndices()) || [];
      let aExportRows;

      if (aSelIdx.length > 0) {
        aExportRows = aSelIdx.map(i => (oPR.getProperty("/rows") || [])[i]).filter(Boolean);
      } else {
        aExportRows = aFiltered.length ? aFiltered : aAllRows;
      }

      if (!aExportRows.length) {
        sap.m.MessageToast.show("Selection is empty.");
        return;
      }

      await this._ensureRowsSimulatedForExport(aExportRows);

      const aExportRowsFinal = aExportRows.map(r => ({
        ...r,
        PRStatus: this._formatPRStatusForExport(r),
        SimulationStatus: this._formatSimStatusForExport(r),
        ErrorLog: this._formatPRLogsForExport(r.SimulationLogs)
      }));

      const oSheet = new sap.ui.export.Spreadsheet({
        workbook: { columns: this._getPRExportColumns() },
        dataSource: aExportRowsFinal,
        fileName: aSelIdx.length ? "PR_Monitor_Selected.xlsx" : "PR_Monitor_Filtered.xlsx"
      });

      oSheet.build().finally(() => oSheet.destroy());
    },

    _getPRExportColumns: function () {
      return [
        { label: "PR Status", property: "PRStatus" },
        { label: "Simulation Status", property: "SimulationStatus" },
        { label: "PR", property: "PurReqNumber" },
        { label: "Item", property: "PurReqItemNo" },
        { label: "PR Item Description", property: "PRItemDesc" },
        { label: "Material", property: "MaterialNo" },
        { label: "Material Description", property: "MaterialDesc" },
        { label: "Vendor", property: "FixedVendor" },
        { label: "Vendor Name", property: "FixedVendorName" },
        { label: "Plant", property: "PlantCode" },
        { label: "Purchasing Org", property: "PurchasingOrg" },
        { label: "Purchasing Group", property: "PurchasingGrp" },
        { label: "MRP Controller", property: "MrpController" },
        { label: "Document Status", property: "DocumentStatus" },
        { label: "Order Qty", property: "OrderQuantity" },
        { label: "UoM", property: "UnitOfMeasure" },
        { label: "Currency", property: "Currency" },
        { label: "Price", property: "Valuation_Price" },
        { label: "Delivery Date", property: "DeliveryDate" },
        { label: "Release Date", property: "ReleaseDate" },
        { label: "Document Date", property: "DocumentDate" },
        { label: "Email", property: "EmailAddress" },
        { label: "Contract", property: "ContractNo" },
        { label: "Error Log", property: "ErrorLog" }
      ];
    },

    _labelForPRField: function (s) {
      const m = {
        PurReqNumber: "Purchase Requisition",
        PurReqItemNo: "Item",
        PRItemDesc: "PR Item Desc",
        MaterialNo: "Material",
        FixedVendor: "Fixed Vendor",
        FixedVendorName: "Vendor Name",
        PurchasingOrg: "Purch. Org",
        PurchasingGrp: "Purch. Group",
        MrpController: "MRP Ctrl",
        PlantCode: "Plant",
        DocumentStatus: "Doc Status",
        DocumentType: "Doc Type",
        DeliveryDate: "Delivery Date",
        ReleaseDate: "Release Date",
        DocumentDate: "Doc Date",
        OrderQuantity: "Order Qty",
        UnitOfMeasure: "UoM",
        Currency: "Currency",
        Valuation_Price: "Valuation Price",
        CreatedByUser: "Created By",
        RequestorUser: "Requestor",
        EmailAddress: "Email",
        InfoRecordNo: "Info Record",
        AcctAssignCat: "Acct Assign",
        ItemCategory: "Item Category",
        EstkzIndicator: "PR Creation indicator",
        ContractNo: "Contract",
        ContractItemno: "Contract Item"
      };
      return m[s] || s;
    },

    _refreshPRLocalFromBackend: async function () {
      this._clearPRSelection();
      this._snapshotSimToCache();

      await this._loadPRsToLocal({ skipBuildFilterBar: true, resetPage: false });
    },

    _attachAutoSimulation: function () {
      const oTable = this.byId("prTable");
      const oBinding = oTable.getBinding("rows");
      if (!oBinding) return;

      const trigger = () => {
        clearTimeout(this._simTimer);
        this._simTimer = setTimeout(() => this._simulateVisibleRows(), 300);
      };

      oBinding.attachDataReceived(trigger);
    },

    _simulateVisibleRows: function () {
      return this._enqueuePRSimulation(async () => {
        const oTable = this.byId("prTable");
        if (!oTable) return;

        const iFirst = oTable.getFirstVisibleRow();
        const iCount = oTable.getVisibleRowCount();

        const aUnique = [];
        const mSeen = new Set();

        for (let i = iFirst; i < iFirst + iCount; i++) {
          const oCtx = oTable.getContextByIndex(i);
          if (!oCtx) continue;

          const o = oCtx.getObject();
          if (!o) continue;
          if (o.SimulationState === "DONE") continue;

          const key = `${o.PurReqNumber}:${o.PurReqItemNo}`;
          if (mSeen.has(key)) continue;
          mSeen.add(key);

          aUnique.push({
            PurReqNumber: o.PurReqNumber,
            PurReqItemNo: o.PurReqItemNo
          });
        }

        for (const t of aUnique) {
          await this._simulateByKey(t);
        }
      });
    },

    _simulateFilteredRows: function () {
      return this._enqueuePRSimulation(async () => {
        const oPR = this.getView().getModel("prLocal");
        const aFiltered = oPR.getProperty("/filteredRows") || [];

        const aUnique = [];
        const mSeen = new Set();

        for (const o of aFiltered) {
          if (!o) continue;
          if (o.SimulationState === "DONE") continue;

          const key = `${o.PurReqNumber}:${o.PurReqItemNo}`;
          if (mSeen.has(key)) continue;
          mSeen.add(key);

          aUnique.push({
            PurReqNumber: o.PurReqNumber,
            PurReqItemNo: o.PurReqItemNo
          });
        }

        for (const t of aUnique) {
          await this._simulateByKey(t);
        }
      });
    },

    _findContextByKey: function (sPR, sItem) {
      const oTable = this.byId("prTable");
      const oBinding = oTable.getBinding("rows");
      if (!oBinding) return null;

      const iFirst = oTable.getFirstVisibleRow();
      const iCount = oTable.getVisibleRowCount();

      for (let i = iFirst; i < iFirst + iCount; i++) {
        const oCtx = oTable.getContextByIndex(i);
        if (!oCtx) continue;
        if (oCtx.getProperty("PurReqNumber") === sPR && oCtx.getProperty("PurReqItemNo") === sItem) {
          return oCtx;
        }
      }
      return null;
    },

    _simulateByKey: async function (t, sActionName) {
      const sAction = sActionName || "prSimulateMultiple";
      const key = `${t.PurReqNumber}:${t.PurReqItemNo}`;

      const found = this._findRowByKeyInAll(t.PurReqNumber, t.PurReqItemNo);
      if (!found || !found.row) return;

      this._setSimForKey(t.PurReqNumber, t.PurReqItemNo, {
        SimulationState: "PENDING",
        SimulationError: false,
        SimulationWarn: false,
        SimulationLogs: []
      });

      try {
        const oFull = this._buildPRToPOItem(found.row);

        const aReturn = await this._executeCatalogAction(sAction, {
          Items: [oFull]
        });

        const aLogs = (aReturn || []).map(m => ({
          type: m.MsgType || "I",
          text: m.MsgText || ""
        }));

        const bError = aLogs.some(l => l.type === "E" || l.type === "A");
        const bWarn  = !bError && aLogs.some(l => l.type === "W");

        this._setSimForKey(t.PurReqNumber, t.PurReqItemNo, {
          SimulationState: "DONE",
          SimulationError: bError,
          SimulationWarn: bWarn,
          SimulationLogs: aLogs
        });

      } catch (e) {
        const aFailLogs = [{
          type: "E",
          text: "Simulation request failed: " + (e?.message || e)
        }];

        this._setSimForKey(t.PurReqNumber, t.PurReqItemNo, {
          SimulationState: "DONE",
          SimulationError: true,
          SimulationWarn: false,
          SimulationLogs: aFailLogs
        });
      }
    },

    _getPRTable: function () {
      return this.byId("prTable");
    },

    _applyPRPageSize: function (iSize) {
      var oTable = this._getPRTable();
      if (!oTable) return;

      oTable.setVisibleRowCount(iSize);
      oTable.setVisibleRowCountMode("Fixed");
    },

    onPRTableSelectionChange: function (oEvent) {
      var oTable = oEvent.getSource();
      var iCount = oTable.getSelectedIndices().length;
      this.getView().getModel("ui").setProperty("/selectedCount", iCount);
    },

    _getSelectedPRContexts: function () {
      var oTable = this._getPRTable();
      if (!oTable) return [];

      var aIdx = oTable.getSelectedIndices();
      return aIdx.map(function (i) {
        return oTable.getContextByIndex(i);
      }).filter(Boolean);
    },

    _clearPRSelection: function () {
      var oTable = this._getPRTable();
      if (oTable) {
        oTable.clearSelection();
      }
      this.getView().getModel("ui").setProperty("/selectedCount", 0);
    },

    _refreshPRTable: function () {
      var oTable = this._getPRTable();
      if (!oTable) return;

      var oBinding = oTable.getBinding("rows");
      if (oBinding) {
        oBinding.refresh();
      }
    },

    onPRSearch: function () {
      this._applyPRFiltersFromFilterBar();
    },

    onPRFilterChange: function () {
      if (this._applyingVariant) return;
      this._applyPRFiltersFromFilterBar();
    },

    onPRAfterVariantLoad: function () {
      this._applyPRFiltersFromFilterBar();
    },

    onPRFilterImmediateChange: function () {
      if (this._applyingVariant) return;
      clearTimeout(this._prFilterTimer);
      this._prFilterTimer = setTimeout(() => this._applyPRFiltersFromFilterBar(), 150);
    },

    _toYYYYMMDD: function (oDate) {
      const y = String(oDate.getFullYear());
      const m = String(oDate.getMonth() + 1).padStart(2, "0");
      const d = String(oDate.getDate()).padStart(2, "0");
      return y + m + d;
    },

    onPRStatusChange: function () {
      this._applyPRFiltersFromFilterBar();
    },

    _isDeleted: function (oRow) {
      return oRow.DeletionIndic === "X";
    },

    _isOpen: function (oRow) {
      return oRow.DeletionIndic !== "X";
    },

    _applyPRFiltersFromFilterBar: function (mOpts) {
      mOpts = mOpts || {};
      const bResetPage = (mOpts.resetPage !== false);
      const bSkipAutoSim = !!mOpts.skipAutoSim;

      const oFB = this.byId("prFilterBar");
      const oPR = this.getView().getModel("prLocal");
      const oUI = this.getView().getModel("ui");
      if (!oFB || !oPR || !oUI) return;

      const aAll = oPR.getProperty("/allRows") || [];
      let aFiltered = aAll.slice();

      const aItems = oFB.getFilterGroupItems() || [];

      aItems.forEach((oItem) => {
        const sField = oItem.getName();
        const oCtrl = oItem.getControl();
        if (!oCtrl) return;

        if (sField === "SimStatus" || sField === "PRStatus") return;

        if (oCtrl.isA("sap.m.Input")) {
          const sVal = (oCtrl.getValue() || "").trim().toLowerCase();
          if (!sVal) return;

          aFiltered = aFiltered.filter((r) =>
            String(r[sField] ?? "").toLowerCase().includes(sVal)
          );
          return;
        }

        if (oCtrl.isA("sap.m.DateRangeSelection")) {
          const dFrom = oCtrl.getDateValue();
          const dTo = oCtrl.getSecondDateValue();
          if (!dFrom && !dTo) return;

          const dStart = dFrom || dTo;
          const dEnd = dTo || dFrom;

          const sStart = this._toYYYYMMDD(dStart);
          const sEnd = this._toYYYYMMDD(dEnd);

          aFiltered = aFiltered.filter((r) => {
            const v = String(r[sField] ?? "");
            return v >= sStart && v <= sEnd;
          });
          return;
        }
      });

      const sSim = oUI.getProperty("/simStatusFilter") || "ALL";
      if (sSim === "ERROR") {
        aFiltered = aFiltered.filter(this._isSimError.bind(this));
      } else if (sSim === "SUCCESS") {
        aFiltered = aFiltered.filter(this._isSimSuccess.bind(this));
      }

      const sPR = oUI.getProperty("/prStatusFilter") || "ALL";
      if (sPR === "DELETED") {
        aFiltered = aFiltered.filter(this._isDeleted.bind(this));
      } else if (sPR === "OPEN") {
        aFiltered = aFiltered.filter(this._isOpen.bind(this));
      }

      oPR.setProperty("/filteredRows", aFiltered);

      if (bResetPage) {
        oUI.setProperty("/pageIndex", 0);
      }

      this._recalcPRPager();
      this._setPRPage(oUI.getProperty("/pageIndex") || 0, { skipAutoSim: bSkipAutoSim });

      oUI.setProperty("/selectedCount", 0);
      var oTable = this.byId("prTable");
      if (oTable) oTable.clearSelection();
    },

    onPOTableSelectionChange: function (oEvent) {
      var oTable = oEvent.getSource();
      var iCount = oTable.getSelectedIndices().length;

      this.getView().getModel("ui").setProperty("/selectedCountPO", iCount);
    },

    _buildPRToPOItem: function (o) {
      const vendor = o.FixedVendor || o.Vendor || "";

      return {
        PurReqNumber:     o.PurReqNumber || o.PurchaseReq,
        PurReqItemNo:     o.PurReqItemNo || o.PurchaseReqItem,

        PRItemDesc:       o.PRItemDesc || o.PRItemDescription || "",
        MaterialNo:       o.MaterialNo || "",
        MaterialDesc:     o.MaterialDesc || "",
        Vendor:           vendor,
        FixedVendorName:  o.FixedVendorName || "",
        Currency:         o.Currency || "",
        OrderQuantity:    o.OrderQuantity || "",
        UnitOfMeasure:    o.UnitOfMeasure || "",
        Valuation_Price:  o.Valuation_Price || "",
        PlantCode:        o.PlantCode || "",
        PurchasingOrg:    o.PurchasingOrg || "",
        InfoRecordNo:     o.InfoRecordNo || "",
        MrpController:    o.MrpController || "",
        PurchasingGrp:    o.PurchasingGrp || "",
        AcctAssignCat:    o.AcctAssignCat || "",
        ItemCategory:     o.ItemCategory || "",
        EstkzIndicator:   o.EstkzIndicator || "",
        DocumentStatus:   o.DocumentStatus || "",
        DocumentDate:     o.DocumentDate || "",
        ReleaseDate:      o.ReleaseDate || "",
        DeliveryDate:     o.DeliveryDate || "",
        CreatedByUser:    o.CreatedByUser || "",
        UnDeletionIndic:  o.UnDeletionIndic || "",
        DeletionIndic:    o.DeletionIndic || "",
        ContractNo:       o.ContractNo || "",
        ContractItemno:   o.ContractItemno || "",
        DocumentType:     o.DocumentType || "",
        RequestorUser:    o.RequestorUser || "",
        EmailAddress:     o.EmailAddress || ""
      };
    },

    onCreatePOSingle: async function () {
      var aCtx = this._getSelectedPRContexts();

      if (!aCtx.length) {
        MessageToast.show("Please select at least one PR.");
        return;
      }

      const aSelectedRows = aCtx.map(c => c.getObject()).filter(Boolean);
      const aNav = aCtx.map(c => this._buildPRToPOItem(c.getObject()));

      try {
        this.getView().setBusy(true);
        const mPayload = { Nav_PRsToPOs: aNav };
        var aReturn = await this._executeCatalogAction("prsToSinglePO", mPayload);

        this._showBackendMessages(aReturn);

        try {
          //await this._sendEmailForPRRows(aSelectedRows);
          sap.m.MessageToast.show("PO created and email triggered");
        } catch (mailErr) {
          sap.m.MessageToast.show("PO created, but email trigger failed");
        }

        this._clearPRSelection();
        await this._refreshPRLocalFromBackend();

      } catch (e) {
        console.error("prsToSinglePO failed:", e);
        MessageToast.show("Create PO failed: " + (e.message || e));
      } finally {
        this.getView().setBusy(false);
      }
    },

    onCreatePOMulti: async function () {
      var aCtx = this._getSelectedPRContexts();

      if (!aCtx.length) {
        MessageToast.show("Please select at least one PR.");
        return;
      }

      const aSelectedRows = aCtx.map(c => c.getObject()).filter(Boolean);
      const aNav = aCtx.map(c => this._buildPRToPOItem(c.getObject()));

      try {
        this.getView().setBusy(true);

        var aReturn = await this._executeCatalogAction("prsToMultiplePO", {
          Nav_PRsToPOs: aNav
        });

        this._showBackendMessages(aReturn);

        try {
          //await this._sendEmailForPRRows(aSelectedRows);
          sap.m.MessageToast.show("POs created and email triggered");
        } catch (mailErr) {
          sap.m.MessageToast.show("POs created, but email trigger failed");
        }

        this._clearPRSelection();
        await this._refreshPRLocalFromBackend();
      } catch (e) {
        console.error("prsToMultiplePO failed:", e);
        MessageToast.show("Create Multiple POs failed: " + (e.message || e));
      } finally {
        this.getView().setBusy(false);
      }
    },

    _sendEmailForPRRows: async function (aRows) {
      if (!Array.isArray(aRows) || !aRows.length) return;

      const oPayload = {
        Nav_AttachPR: aRows.map(r => ({
          PurReqNumber: r.PurReqNumber,
          PurReqItemNo: r.PurReqItemNo,
          PRItemDesc: r.PRItemDesc,
          MaterialNo: r.MaterialNo,
          MaterialDesc: r.MaterialDesc,
          FixedVendor: r.FixedVendor,
          FixedVendorName: r.FixedVendorName,
          Currency: r.Currency,
          OrderQuantity: r.OrderQuantity,
          UnitOfMeasure: r.UnitOfMeasure,
          Valuation_Price: r.Valuation_Price,
          PlantCode: r.PlantCode,
          PurchasingOrg: r.PurchasingOrg,
          InfoRecordNo: r.InfoRecordNo,
          MrpController: r.MrpController,
          PurchasingGrp: r.PurchasingGrp,
          AcctAssignCat: r.AcctAssignCat,
          ItemCategory: r.ItemCategory,
          EstkzIndicator: r.EstkzIndicator,
          DocumentStatus: r.DocumentStatus,
          DocumentDate: this._fmtDate(r.DocumentDate),
          ReleaseDate: this._fmtDate(r.ReleaseDate),
          DeliveryDate: this._fmtDate(r.DeliveryDate),
          CreatedByUser: r.CreatedByUser,
          UnDeletionIndic: r.UnDeletionIndic,
          DeletionIndic: r.DeletionIndic,
          ContractNo: r.ContractNo,
          ContractItemno: r.ContractItemno,
          DocumentType: r.DocumentType,
          RequestorUser: r.RequestorUser,
          EmailAddress: r.EmailAddress,
          Message: this._formatPRLogsForExport(r.SimulationLogs) || ""
        }))
      };

      await this._callAttachPRs(oPayload);
    },

    _findRowByKeyInAll: function (sPR, sItem) {
      const oPR = this.getView().getModel("prLocal");
      const aAll = oPR.getProperty("/allRows") || [];
      const idx = aAll.findIndex(r => r.PurReqNumber === sPR && r.PurReqItemNo === sItem);
      return idx >= 0 ? { idx, row: aAll[idx], aAll } : null;
    },

    _setSimForKey: function (sPR, sItem, oSim) {
      const key = `${sPR}:${sItem}`;

      // 1) update cache
      this._simCache.set(key, {
        SimulationState: oSim.SimulationState,
        SimulationError: !!oSim.SimulationError,
        SimulationWarn:  !!oSim.SimulationWarn,
        SimulationLogs:  Array.isArray(oSim.SimulationLogs) ? oSim.SimulationLogs.slice() : []
      });

      const found = this._findRowByKeyInAll(sPR, sItem);
      if (found) {
        Object.assign(found.row, oSim);
        const oPR = this.getView().getModel("prLocal");
        oPR.setProperty("/allRows", found.aAll);
      }

      const oCtx = this._findContextByKey(sPR, sItem);
      if (oCtx) {
        oCtx.setProperty("SimulationState", oSim.SimulationState);
        oCtx.setProperty("SimulationError", !!oSim.SimulationError);
        oCtx.setProperty("SimulationWarn",  !!oSim.SimulationWarn);
        oCtx.setProperty("SimulationLogs",  oSim.SimulationLogs || []);
      }
    },

    _runManualSimulationByKeys: async function (aKeys, sActionName) {
      if (!aKeys.length) return;

      try {
        this.getView().setBusy(true);

        aKeys.forEach(k => this._setSimForKey(k.PurReqNumber, k.PurReqItemNo, {
          SimulationState: "PENDING",
          SimulationError: false,
          SimulationWarn: false,
          SimulationLogs: []
        }));

        for (const k of aKeys) {
          await this._simulateByKey(k, sActionName);
        }

        this._setPRPage(this.getView().getModel("ui").getProperty("/pageIndex") || 0);
        this._clearPRSelection();
      } finally {
        this.getView().setBusy(false);
      }
    },

    _runManualSimulation: async function (aCtx, sActionName) {
      if (!aCtx || !aCtx.length) return;

      try {
        this.getView().setBusy(true);

        const aNav = aCtx.map(c =>
          this._buildPRToPOItem(c.getObject())
        );

        // marcar todas como PENDING
        aNav.forEach(it => {
          this._setSimForKey(it.PurReqNumber, it.PurReqItemNo, {
            SimulationState: "PENDING",
            SimulationError: false,
            SimulationWarn: false,
            SimulationLogs: []
          });
        });

        const aReturn = await this._executeCatalogAction(sActionName, {
          Items: aNav
        });

        this._showBackendMessages(aReturn);

        this._setPRPage(
          this.getView().getModel("ui").getProperty("/pageIndex") || 0
        );

        this._clearPRSelection();

      } finally {
        this.getView().setBusy(false);
      }
    },

    onSimulateSingle: function () {
      const aCtx = this._getSelectedPRContexts();
      if (!aCtx.length) {
        MessageToast.show("Please select at least one PR to simulate.");
        return;
      }
      return this._runManualSimulation(aCtx, "prSimulateSingle");
    },

    onSimulateMultiple: function () {
      const aCtx = this._getSelectedPRContexts();
      if (!aCtx.length) {
        MessageToast.show("Please select at least one PR to simulate.");
        return;
      }
      return this._runManualSimulation(aCtx, "prSimulateMultiple");
    },

    onEditPR: async function () {
      var aCtx = this._getSelectedPRContexts();

      if (aCtx.length !== 1) {
        MessageToast.show("Please select only one row to edit.");
        return;
      }

      await this._openEditPRDialog(aCtx[0]);
    },

    _openEditPRDialog: async function (oCtx) {
      if (!this._oEditPRDialog) {
        this._oEditPRDialog = await sap.ui.core.Fragment.load({
          id: this.getView().getId(),
          name: "prposervicios.view.fragments.EditPRDialog",
          controller: this
        });
        this.getView().addDependent(this._oEditPRDialog);
      }

      this._oEditCtx = oCtx;

      const oData = Object.assign({}, oCtx.getObject());

      oData.Agreement = oData.Agreement || oData.ContractNo || "";
      oData.AgreementLine = oData.AgreementLine || oData.ContractItemno || "";

      const oEditModel = new sap.ui.model.json.JSONModel(oData);
      this.getView().setModel(oEditModel, "edit");

      return new Promise((resolve, reject) => {
        this._resolveEditPR = resolve;
        this._rejectEditPR = reject;
        this._oEditPRDialog.open();
      });
    },

    onCancelEditPR: function () {
      if (this._oEditPRDialog) this._oEditPRDialog.close();
      if (this._resolveEditPR) {
        this._resolveEditPR({ cancelled: true, editReturn: [] });
        this._resolveEditPR = null;
        this._rejectEditPR = null;
      }
    },

    onDeletePR: async function () {
      var aCtx = this._getSelectedPRContexts();
      if (!aCtx.length) {
        MessageToast.show("Please select at least one row to delete.");
        return;
      }

      var aItems = aCtx.map(function (oCtx) {
        var o = oCtx.getObject();
        return {
          PurReqNumber: o.PurchaseReq || o.PurReqNumber,
          PurReqItemNo: o.PurchaseReqItem || o.PurReqItemNo
        };
      });

      try {
        this.getView().setBusy(true);

        var aReturn = await this._executeCatalogAction("prDelete", {
          Items: aItems
        });

        const aErrors = (aReturn || []).filter(m => m.MsgType === "E");
        if (aErrors.length) {
          const sText = aErrors.map(m => m.MsgText).join("\n");
          MessageBox.error(sText || "Delete failed.");
          return;
        }

        MessageToast.show("PR successfully deleted");

        this._clearPRSelection();
        await this._refreshPRLocalFromBackend();
        const oPR = this.getView().getModel("prLocal");

      } catch (e) {
        console.error("prDelete failed:", e);
        MessageToast.show("Delete failed: " + (e.message || e));
      } finally {
        this.getView().setBusy(false);
      }
    },

    _executeCatalogAction: async function (sActionName, mParams) {
      var oModel = this.getView().getModel(); 
      if (!oModel) throw new Error("No default OData V4 model found on the view.");

      try {
        return await this._executeActionPath("/" + sActionName + "(...)", mParams, oModel);
      } catch (e1) {
        return await this._executeActionPath("/CatalogService." + sActionName + "(...)", mParams, oModel);
      }
    },

    _executeActionPath: async function (sPath, mParams, oModel) {
      var oAction = oModel.bindContext(sPath);

      Object.keys(mParams || {}).forEach(function (k) {
        oAction.setParameter(k, mParams[k]);
      });

      await oAction.execute();

      var oResult = oAction.getBoundContext().getObject();
      if (Array.isArray(oResult)) return oResult;
      if (oResult && Array.isArray(oResult.value)) return oResult.value;
      return oResult ? [oResult] : [];
    },

    _showBackendMessages: function (aReturn) {
      const aMsgs = Array.isArray(aReturn) ? aReturn : [];
      if (!aMsgs.length) return;

      const aErrors = aMsgs.filter(m => m.MsgType === "E");
      const aInfos  = aMsgs.filter(m => m.MsgType !== "E" && m.MsgType !== "W");

      if (aErrors.length) {
        const sText = aErrors.map(m => m.MsgText).filter(Boolean).join("\n");
        MessageBox.error(sText || "Operation failed.");
        return; 
      }

      const sText = aInfos.map(m => m.MsgText).filter(Boolean).join("\n");
      if (sText) MessageToast.show(sText);
    },

    onUndeletePR: async function () {
      var aCtx = this._getSelectedPRContexts();
      if (!aCtx.length) {
        MessageToast.show("Please select at least one row to undelete.");
        return;
      }

      var aDeletedCtx = aCtx.filter(function (oCtx) {
        var o = oCtx.getObject();
        return String(o.DeletionIndic || "").toUpperCase() === "X";
      });

      if (!aDeletedCtx.length) {
        MessageToast.show("No deleted PRs selected.");
        return;
      }

      var aItems = aDeletedCtx.map(function (oCtx) {
        var o = oCtx.getObject();
        return {
          PurReqNumber: o.PurReqNumber,
          PurReqItemNo: o.PurReqItemNo
        };
      });

      try {
        this.getView().setBusy(true);

        var aReturn = await this._executeCatalogAction("prUndelete", {
          Items: aItems
        });

        const aErrors = (aReturn || []).filter(m => m.MsgType === "E");
        if (aErrors.length) {
          const sText = aErrors.map(m => m.MsgText).join("\n");
          MessageBox.error(sText || "Undelete failed.");
          return;
        }

        MessageToast.show("PR successfully Undeleted");

        this._clearPRSelection();
        await this._refreshPRLocalFromBackend();
      } catch (e) {
        console.error("prUndelete failed:", e);
        MessageToast.show("Undelete failed: " + (e.message || e));
      } finally {
        this.getView().setBusy(false);
      }
    },
    _padVendor10: function (v) {
      return v ? String(v).padStart(10, "0") : v;
    },

    _combineEditAndSimMessages: function (aEditReturn, aSimReturn) {
      const aEdit = (aEditReturn || []).map(m => this._normalizeBackendMsg(m, "EDIT"));
      const aSim  = (aSimReturn  || []).map(m => this._normalizeBackendMsg(m, "SIM"));

      const byKey = new Map();

      const add = (m) => {
        const sText = String(m.MsgText || "").trim().replace(/\s+/g, " ");
        const key = `${m.MsgType}|${sText}`;

        const prev = byKey.get(key);
        if (!prev) {
          byKey.set(key, { ...m, MsgText: sText, Sources: new Set([m.Source]) });
        } else {
          prev.Sources.add(m.Source);
        }
      };

      aEdit.forEach(add);
      aSim.forEach(add);

      const order = { E: 0, A: 1, W: 2, I: 3, S: 4 };
      return Array.from(byKey.values())
        .map(x => ({
          MsgType: x.MsgType,
          MsgText: x.MsgText,
          Source: x.Sources.size >= 2 ? "BOTH" : Array.from(x.Sources)[0]
        }))
        .sort((a, b) => (order[a.MsgType] ?? 9) - (order[b.MsgType] ?? 9));
    },

    _normalizeBackendMsg: function (m, sDefaultSource) {
      if (typeof m === "string") {
        return { MsgType: "E", MsgText: m, Source: sDefaultSource };
      }

      let t = String(m?.MsgType || m?.type || m?.severity || "I").toUpperCase();

      if (t === "ERROR") t = "E";
      if (t === "WARNING") t = "W";
      if (t === "SUCCESS") t = "S";

      if (!["E","A","W","I","S"].includes(t)) t = "I";

      const text = (m?.MsgText || m?.message || m?.text || JSON.stringify(m));

      return {
        MsgType: t,
        MsgText: String(text),
        Source: m?.Source || sDefaultSource
      };
    },

    _showCombinedErrors: function (aMsgs, { title } = {}) {
      const a = aMsgs || [];
      const aErr = a.filter(m => m.MsgType === "E" || m.MsgType === "A");
      const aWarn = a.filter(m => m.MsgType === "W");

      if (!aErr.length && !aWarn.length) {
        MessageToast.show("Edit saved and simulation OK.");
        return;
      }

      const fmt = (m) => `• [${m.Source}] ${m.MsgText}`;
      const sText =
        (aErr.length ? `Errors (${aErr.length}):\n${aErr.map(fmt).join("\n")}\n\n` : "") +
        (aWarn.length ? `Warnings (${aWarn.length}):\n${aWarn.map(fmt).join("\n")}` : "");

      if (aErr.length) {
        MessageBox.error(sText.trim(), { title: title || "Validation errors" });
      } else {
        MessageBox.warning(sText.trim(), { title: title || "Warnings" });
      }
    },

    onSaveEditPR: async function () {
      var oEdit = this.getView().getModel("edit")?.getProperty("/");
      if (!oEdit) {
        MessageToast.show("No edit data.");
        return;
      }

      var aItems = [{
        PurReqNumber: oEdit.PurReqNumber,
        PurReqItemNo: oEdit.PurReqItemNo,
        MaterialNo: (oEdit.MaterialNo || "").trim(),
        PRItemDesc: (oEdit.PRItemDesc || "").trim(), 
        FixedVendor: this._padVendor10((oEdit.FixedVendor || "").trim()),                          
        OrderQuantity: String(oEdit.OrderQuantity || "").trim(),
        DeliveryDate: String(oEdit.DeliveryDate || "").trim(),
        Agreement: String(oEdit.Agreement || "").trim(),
        AgreementLine: String(oEdit.AgreementLine || "").trim(),
        FixedVendorIndicator: oEdit.FixedVendorIndicator,
        MRPIndicator: oEdit.MRPIndicator
      }];

      try {
        this.getView().setBusy(true);

        var aReturn = await this._executeCatalogAction("prChange", {
          Items: aItems
        });

        var bHasEditError = Array.isArray(aReturn) && aReturn.some(function (m) {
          var t = String(m.MsgType || "").toUpperCase();
          return t === "E" || t === "A";
        });

        if (bHasEditError) {
          this._showCombinedErrors(
            this._combineEditAndSimMessages(aReturn, []),
            { title: "Edit errors" }
          );
          return;
        }

        this._oEditPRDialog.close();
        await this._refreshPRLocalFromBackend();

        var aSimReturn = [];
        try {
          aSimReturn = await this._runManualSimulationByKeys(
            [{ PurReqNumber: oEdit.PurReqNumber, PurReqItemNo: oEdit.PurReqItemNo }],
            "prSimulateSingle"
          );
        } catch (eSim) {
          aSimReturn = [{ MsgType: "E", MsgText: eSim.message || String(eSim), Source: "SIM" }];
        }

        var aCombined = this._combineEditAndSimMessages(aReturn, aSimReturn);
        this._showCombinedErrors(aCombined, { title: "Edit + Simulation result" });
      } catch (e) {
        console.error("prChange failed:", e);
        MessageToast.show("Save failed: " + (e.message || e));
      } finally {
        this.getView().setBusy(false);
      }
    },

    _forceFixedVendorItemsHeaderTotal: function () {
      const total = this._oFixedVendorPaging?.allRows?.length || 0;
      const oDom = this._oFixedVendorVHD?.getDomRef?.();
      if (!oDom) return;

      const aTitles = oDom.querySelectorAll(".sapMTitle, span, div");

      aTitles.forEach((el) => {
        const sText = (el.textContent || "").trim();

        if (/^(Elementos|Items)\s*\(\d+\)$/.test(sText)) {
          el.textContent = `Elements (${total})`;
          el.style.marginTop = "0.5rem";
          el.style.marginBottom = "0.5rem";
          el.style.display = "block";
        }
      });
    },

    onFixedVendorValueHelp: async function () {
      await this._getFixedVendorVHD();
      await this._applyFixedVendorVHFilters();
      this._oFixedVendorVHD.open();

      setTimeout(() => {
        this._forceFixedVendorItemsHeaderTotal();
      }, 300);
    },

    _getFixedVendorVHD: async function () {
      if (this._oFixedVendorVHD) return;

      const oView = this.getView();
      const PAGE_SIZE = 8;

      // Estado de paginación
      this._oFixedVendorPaging = {
        allRows: [],
        currentPage: 0,
        pageSize: PAGE_SIZE
      };

      await new Promise((resolve) => {
        sap.ui.require(
          ["sap/ui/comp/valuehelpdialog/ValueHelpDialog"],
          (ValueHelpDialog) => {

            this._oFixedVendorVHD = new ValueHelpDialog({
              title: "Select Fixed Vendor",
              supportMultiselect: false,
              supportRanges: false,
              supportRangesOnly: false,
              key: "FixedVendor",
              descriptionKey: "FixedVendor",
              ok: (oEvent) => {
                const aTokens = oEvent.getParameter("tokens") || [];
                const sKey = aTokens[0]?.getKey?.() || "";

                const oTable = this._oFixedVendorVHD.getTable();
                const iIndex = oTable.getSelectedIndex();
                const oCtx = iIndex >= 0 ? oTable.getContextByIndex(iIndex) : null;
                const oSelected = oCtx ? oCtx.getObject() : null;

                const oEditModel = oView.getModel("edit");
                oEditModel.setProperty("/FixedVendor", sKey);

                if (oSelected) {
                  oEditModel.setProperty("/Agreement", oSelected.Agreement || "");
                  oEditModel.setProperty("/AgreementLine", oSelected.AgreementLine || "");

                  oEditModel.setProperty("/FixedVendorIndicator", oSelected.FixedVendorIndicator || "");
                  oEditModel.setProperty("/MRPIndicator", oSelected.MRPIndicator || "");
                }

                this._oFixedVendorVHD.close();
              },
              cancel: () => this._oFixedVendorVHD.close()
            });

            oView.addDependent(this._oFixedVendorVHD);

            // Modelo JSON para la página actual
            this._oFixedVendorVHModel = new sap.ui.model.json.JSONModel({ rows: [] });

            // Toolbar de paginación
            const oToolbar = new sap.m.Toolbar({
              content: [
                new sap.m.ToolbarSpacer(),
                new sap.m.Button({
                  icon: "sap-icon://navigation-left-arrow",
                  tooltip: "Previous",
                  press: () => this._fixedVendorGoToPage(this._oFixedVendorPaging.currentPage - 1)
                }),
                this._oFixedVendorPageLabel = new sap.m.Label({ text: "Page 1" }),
                new sap.m.Button({
                  icon: "sap-icon://navigation-right-arrow",
                  tooltip: "Next",
                  press: () => this._fixedVendorGoToPage(this._oFixedVendorPaging.currentPage + 1)
                }),
                new sap.m.ToolbarSpacer()
              ]
            });

            // Table
            const oTable = this._oFixedVendorVHD.getTable();

            oTable.setVisibleRowCountMode(sap.ui.table.VisibleRowCountMode.Fixed);
            oTable.setVisibleRowCount(PAGE_SIZE);
            oTable.setSelectionMode(sap.ui.table.SelectionMode.Single);
            oTable.setFooter(oToolbar);
            oTable.setModel(this._oFixedVendorVHModel, "vh");
            oTable.bindRows({ path: "vh>/rows" });

            this._oFixedVendorVHD.setContentHeight("22rem");

            oTable.addColumn(new sap.ui.table.Column({
              label: new sap.m.Label({ text: "Vendor" }),
              template: new sap.m.Text({ text: "{vh>FixedVendor}" }),
              width: "10rem"
            }));
            oTable.addColumn(new sap.ui.table.Column({
              label: new sap.m.Label({ text: "Material" }),
              template: new sap.m.Text({ text: "{vh>Material}" }),
              width: "12rem"
            }));
            oTable.addColumn(new sap.ui.table.Column({
              label: new sap.m.Label({ text: "Plant" }),
              template: new sap.m.Text({ text: "{vh>Plant}" }),
              width: "6rem"
            }));
            oTable.addColumn(new sap.ui.table.Column({
              label: new sap.m.Label({ text: "Agreement" }),
              template: new sap.m.Text({ text: "{vh>Agreement}" }),
              width: "10rem"
            }));
            oTable.addColumn(new sap.ui.table.Column({
              label: new sap.m.Label({ text: "Agreement Line" }),
              template: new sap.m.Text({ text: "{vh>AgreementLine}" }),
              width: "10rem"
            }));

            oTable.addColumn(new sap.ui.table.Column({
              label: new sap.m.Label({ text: "Fixed Vendor Indicator" }),
              template: new sap.m.Text({ text: "{vh>FixedVendorIndicator}" }),
              width: "12rem"
            }));

            oTable.addColumn(new sap.ui.table.Column({
              label: new sap.m.Label({ text: "MRP Indicator" }),
              template: new sap.m.Text({ text: "{vh>MRPIndicator}" }),
              width: "10rem"
            }));

            resolve();
          }
        );
      });
    },

    // Llamar este método después de cargar los datos en _applyFixedVendorVHFilters
    _fixedVendorSetData: function (aAllRows) {
      this._oFixedVendorPaging.allRows = aAllRows;
      this._oFixedVendorPaging.currentPage = 0;
      this._fixedVendorGoToPage(0);
    },

    _fixedVendorGoToPage: function (iPage) {
      const { allRows, pageSize } = this._oFixedVendorPaging;
      const totalPages = Math.ceil(allRows.length / pageSize);

      if (iPage < 0 || iPage >= totalPages) return;

      this._oFixedVendorPaging.currentPage = iPage;

      const start = iPage * pageSize;
      const pageRows = allRows.slice(start, start + pageSize);

      this._oFixedVendorVHModel.setProperty("/rows", pageRows);

      const oTable = this._oFixedVendorVHD.getTable();
      oTable.clearSelection();

      this._oFixedVendorPageLabel.setText(
        `Page ${iPage + 1} of ${totalPages}  (${allRows.length} items)`
      );

      setTimeout(() => {
        this._forceFixedVendorItemsHeaderTotal();
      }, 300);
    },

    _applyFixedVendorVHFilters: async function () {
      const oEdit = this.getView().getModel("edit")?.getProperty("/") || {};
      const sMaterial = (oEdit.MaterialNo || "").trim();
      const sPlant = (oEdit.PlantCode || "").trim();

      if (!sMaterial || !sPlant) {
        this._fixedVendorSetData([]); // ← acá
        return;
      }

      const esc = (s) => String(s).replace(/'/g, "''");
      const sPath = `/f4Vendors(Material='${esc(sMaterial)}',Plant='${esc(sPlant)}')`;

      try {
        const oODataModel = this.getView().getModel();
        const oOp = oODataModel.bindContext(sPath, null, { $$groupId: "$direct" });
        const oObj = await oOp.requestObject();
        this._fixedVendorSetData(oObj?.value || []); // ← acá
      } catch (e) {
        this._fixedVendorSetData([]); // ← acá
        console.error("f4Vendors failed", e);
      }
    },

    onErrorLog: function () {
      const aCtx = this._getSelectedPRContexts();
      if (aCtx.length !== 1) {
        sap.m.MessageToast.show("Select exactly one PR to see its log.");
        return;
      }

      const aLogs = aCtx[0].getProperty("SimulationLogs") || [];
      if (!aLogs.length) {
        sap.m.MessageToast.show("No logs for this row.");
        return;
      }

      const sText = aLogs.map(l => `[${l.type}] ${l.text || l.message || ""}`).join("\n");
      sap.m.MessageBox.information(sText, { title: "Detailed Error Log" });
    },

    onSendEmail: async function () {
      try {
        const oTable = this.byId("prTable");
        if (!oTable) return;

        const oPR = this.getView().getModel("prLocal");
        const aRowsShown = oPR.getProperty("/rows") || []; 

        if (!aRowsShown.length) {
          sap.m.MessageToast.show("No PRs to send.");
          return;
        }

        const aSelIdx = oTable.getSelectedIndices?.() || [];
        let aSendRows;

        if (aSelIdx.length > 0) {
          aSendRows = aSelIdx.map(i => aRowsShown[i]).filter(Boolean);
          if (!aSendRows.length) {
            sap.m.MessageToast.show("Selection is empty.");
            return;
          }
        } else {
          aSendRows = aRowsShown; 
        }

        this.getView().setBusy(true);

        const oPayload = {
          Nav_AttachPR: aSendRows.map(r => ({
            PurReqNumber: r.PurReqNumber,
            PurReqItemNo: r.PurReqItemNo,
            PRItemDesc: r.PRItemDesc,
            MaterialNo: r.MaterialNo,
            MaterialDesc: r.MaterialDesc,
            FixedVendor: r.FixedVendor,
            FixedVendorName: r.FixedVendorName,
            Currency: r.Currency,
            OrderQuantity: r.OrderQuantity,
            UnitOfMeasure: r.UnitOfMeasure,
            Valuation_Price: r.Valuation_Price,
            PlantCode: r.PlantCode,
            PurchasingOrg: r.PurchasingOrg,
            InfoRecordNo: r.InfoRecordNo,
            MrpController: r.MrpController,
            PurchasingGrp: r.PurchasingGrp,
            AcctAssignCat: r.AcctAssignCat,
            ItemCategory: r.ItemCategory,
            EstkzIndicator: r.EstkzIndicator,
            DocumentStatus: r.DocumentStatus,
            DocumentDate: this._fmtDate(r.DocumentDate),
            ReleaseDate: this._fmtDate(r.ReleaseDate),
            DeliveryDate: this._fmtDate(r.DeliveryDate),
            CreatedByUser: r.CreatedByUser,
            UnDeletionIndic: r.UnDeletionIndic,
            DeletionIndic: r.DeletionIndic,
            ContractNo: r.ContractNo,
            ContractItemno: r.ContractItemno,
            DocumentType: r.DocumentType,
            RequestorUser: r.RequestorUser,
            EmailAddress: r.EmailAddress,
            Message: this._formatPRLogsForExport(r.SimulationLogs) || ""
          }))
        };
        await this._callAttachPRs(oPayload);

        sap.m.MessageToast.show(aSelIdx.length > 0 ? "Email sent (selected PRs)" : "Email sent (filtered PRs)");
      } catch (e) {
        sap.m.MessageBox.error(e?.message || "Failed to send email");
      } finally {
        this.getView().setBusy(false);
      }
    },

    onSendEmailPO: async function () {
      try {
        const oTable = this.byId("poTable");
        if (!oTable) return;

        const oPO = this.getView().getModel("poLocal");
        const aRowsShown = oPO.getProperty("/rows") || [];

        if (!aRowsShown.length) {
          sap.m.MessageToast.show("No POs to send.");
          return;
        }

        const aSelIdx = oTable.getSelectedIndices?.() || [];
        let aSendRows;

        if (aSelIdx.length > 0) {
          aSendRows = aSelIdx
            .map(i => oTable.getContextByIndex(i))
            .filter(Boolean)
            .map(ctx => ctx.getObject())
            .filter(Boolean);

          if (!aSendRows.length) {
            sap.m.MessageToast.show("Selection is empty.");
            return;
          }
        } else {
          aSendRows = aRowsShown.slice();
        }

        this.getView().setBusy(true);

        const oPayload = {
          // Action: "",
          Nav_AttachPO: aSendRows.map(r => ({
            PONumber: r.PONumber,
            LineNumber: r.LineNumber,
            POMaterial: r.POMaterial,
            PurchaseOrg: r.PurchaseOrg,
            OrderType: r.OrderType,
            POQty: r.POQty,
            Plant: r.Plant,
            CreatedBy: r.CreatedBy,
            CreatedNo: r.CreatedNo,
            Vendor: r.Vendor,
            VendorName: r.VendorName,
            PurReqNumber: r.PurReqNumber,
            PurReqItemNo: r.PurReqItemNo,
            PRQty: r.PRQty,
            PROrderedQty: r.PROrderedQty,
            PRBalanceQty: r.PRBalanceQty,
            DelvCompInd: r.DelvCompInd,
            ScheduledQty: r.ScheduledQty,
            GRNQty: r.GRNQty,
            GRNStatus: r.GRNStatus,
            POVendorConfStatus: r.POVendorConfStatus,
            PODelDate: r.PODelDate,
            GRNDate: r.GRNDate,
            Message: "Triggered from PR-PO Automation"
          }))
        };

        const aReturn = await this._callAttachPOs(oPayload);

        if (Array.isArray(aReturn)) this._showBackendMessages(aReturn);

        sap.m.MessageToast.show(aSelIdx.length > 0 ? "Email triggered (selected POs)" : "Email triggered (visible POs)");

      } catch (e) {
        sap.m.MessageBox.error(e?.message || "Failed to send PO email");
      } finally {
        this.getView().setBusy(false);
      }
    },

    _callAttachPOs: async function (oPayload) {
      const oModel = this.getView().getModel();

      const oAction = oModel.bindContext("/attachPOs(...)", null, { $$groupId: "$auto" });

      if ("Action" in oPayload) {
        oAction.setParameter("Action", oPayload.Action);
      }
      oAction.setParameter("Nav_AttachPO", oPayload.Nav_AttachPO);

      await oAction.execute();

      const oRes = oAction.getBoundContext()?.getObject();
      return oRes?.value ?? oRes;
    },

    _fmtDate: function (v) {
      if (!v) return "";
      if (typeof v === "string" && /^\d{8}$/.test(v)) return v;        
      if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v.replaceAll("-", ""); 
      if (v instanceof Date && !isNaN(v.getTime())) return this._toYYYYMMDD(v);
      return String(v);
    },

    _callAttachPRs: async function (oPayload) {
      const oModel = this.getView().getModel(); 
      const oAction = oModel.bindContext("/attachPRs(...)");

      oAction.setParameter("Nav_AttachPR", oPayload.Nav_AttachPR);

      await oAction.execute();
      return;
    },

    _refreshPRAndResimulateVisible: async function () {
      this._clearPRSelection();

      await this._loadPRsToLocal({ skipBuildFilterBar: true, resetPage: false });

      const oPR = this.getView().getModel("prLocal");
      const aAll = oPR.getProperty("/allRows") || [];

      this._simCache.clear();

      aAll.forEach(r => {
        r.SimulationState = "NEW";
        r.SimulationError = false;
        r.SimulationWarn = false;
        r.SimulationLogs = [];
      });

      oPR.refresh(true);

      await this._simulateVisibleRows(); 
    },

    onShowPOText: function (oEvent) {
      const oSrc = oEvent.getSource();

      const sTitle = oSrc.data("title") || "Text";
      const sProp  = oSrc.data("prop")  || "DeliveryText";

      const oCtx  = oSrc.getBindingContext("poLocal");
      const sText = oCtx?.getProperty(sProp) || "";

      if (!this._poTextPopover) {
        this._poTextPopover = new sap.m.ResponsivePopover({
          title: sTitle,
          contentWidth: "40rem",
          contentHeight: "18rem",
          verticalScrolling: true,
          horizontalScrolling: false,
          content: [
            new sap.m.ScrollContainer({
              height: "16rem",
              vertical: true,
              content: [ new sap.m.Text({ text: sText, wrapping: true }) ]
            })
          ],
          endButton: new sap.m.Button({
            text: "Close",
            press: () => this._poTextPopover.close()
          })
        });

        this.getView().addDependent(this._poTextPopover);
      } else {
        this._poTextPopover.setTitle(sTitle);

        const oScroll = this._poTextPopover.getContent()[0];
        const oText = oScroll.getContent()[0];
        oText.setText(sText);
      }

      this._poTextPopover.openBy(oSrc);
    },

    onRefresh: async function () {
      try {
        this.getView().setBusy(true);
        await this._refreshPRAndResimulateVisible();
        sap.m.MessageToast.show("PRs refreshed and re-simulated");
      } finally {
        this.getView().setBusy(false);
      }
    },

    _getPOTable: function () {
      return this.byId("poTable");
    },

    _fmtYYYYMMDD: function (oDate) {
      if (!oDate) return null;
      const y = String(oDate.getFullYear());
      const m = String(oDate.getMonth() + 1).padStart(2, "0");
      const d = String(oDate.getDate()).padStart(2, "0");
      return y + m + d;
    },

    _fetchPOsFromBackend: async function (sFrom, sTo) {
      const oOData = this.getView().getModel(); 
      const oList = oOData.bindList("/POdatas", null, null, [
        new sap.ui.model.Filter("FromDate", sap.ui.model.FilterOperator.EQ, sFrom),
        new sap.ui.model.Filter("ToDate",   sap.ui.model.FilterOperator.EQ, sTo)
      ], {
        $select: [
          "PONumber","LineNumber",
          "POMaterial","PurchaseOrg","OrderType",
          "Vendor","VendorName",
          "PurReqNumber","PurReqItemNo",
          "POQty","PRQty","PROrderedQty","PRBalanceQty",
          "DelvCompInd","ScheduledQty","GRNQty",
          "Plant","CreatedBy","CreatedNo",
          "GRNStatus","POVendorConfStatus",
          "PODelDate","GRNDate",
        ].join(",")
      });

      const aCtx = await oList.requestContexts(0, 10000);
      return aCtx.map(c => c.getObject());
    },

    _rebindPO: async function () {
      const oDRS = this.byId("poCreatedOn");
      const dFrom = oDRS?.getDateValue?.();
      const dTo   = oDRS?.getSecondDateValue?.();
      if (!dFrom || !dTo) return;

      const sFrom = this._fmtYYYYMMDD(dFrom);
      const sTo   = this._fmtYYYYMMDD(dTo);
      const aAll = await this._fetchPOsFromBackend(sFrom, sTo);

      const oPO = this.getView().getModel("poLocal");
      oPO.setProperty("/allRows", aAll);

      this._buildPOFilterBarFromData(aAll);

      this._buildPOValueHelpsFromAllRows();

      this._applyPOFiltersFromFilterBar({ resetPage: true });
    },

    _buildPOValueHelpsFromAllRows: function () {
      const oPO = this.getView().getModel("poLocal");
      const oVH = this.getView().getModel("poVH");
      if (!oPO || !oVH) return;

      const aAll = oPO.getProperty("/allRows") || [];

      const uniq = (arr) => Array.from(
        new Set(arr.map(v => (v == null ? "" : String(v).trim())).filter(v => v))
      );

      const aGRN = uniq(aAll.map(r => r.GRNStatus)).sort();
      const aOut = uniq(aAll.map(r => r.POVendorConfStatus)).sort();

      oVH.setProperty("/grnStatus", [
        { key: "", text: "All" },
        ...aGRN.map(v => ({ key: v, text: v }))
      ]);

      oVH.setProperty("/outputStatus", [
        { key: "", text: "All" },
        ...aOut.map(v => ({ key: v, text: v }))
      ]);
    },

    _buildPOFilterBarFromData: function (aRows) {
      const oFB = this.byId("poFilterBar");
      if (!oFB) return;

      if (this._poFiltersBuilt) return;
      this._poFiltersBuilt = true;

      const oSample = (aRows && aRows.length) ? aRows[0] : null;
      if (!oSample) return;

      const aExclude = [
        "CreatedNo" // ya existe fijo en el fragment
      ];

      const aDefaultVisible = [
        "Plant",
        "Vendor",
        "GRNStatus",
        "POVendorConfStatus"
      ];

      const aSelectFields = [
        "GRNStatus",
        "POVendorConfStatus"
      ];

      const aDateFields = [
        "PODelDate",
        "GRNDate"
      ];

      const aFields = Object.keys(oSample).filter(function (sField) {
        return !aExclude.includes(sField);
      });

      aFields.sort(function (a, b) {
        const ia = aDefaultVisible.includes(a) ? 0 : 1;
        const ib = aDefaultVisible.includes(b) ? 0 : 1;
        if (ia !== ib) return ia - ib;
        return a.localeCompare(b);
      });

      aFields.forEach(function (sField) {
        const bVisible = aDefaultVisible.includes(sField);
        let oControl;

        if (aDateFields.includes(sField)) {
          oControl = new sap.m.DateRangeSelection({
            width: "18rem",
            placeholder: "From - To",
            delimiter: " - ",
            change: this.onPOFilterChange.bind(this)
          });
        } else if (aSelectFields.includes(sField)) {
          if (sField === "GRNStatus") {
            oControl = new sap.m.Select({
              width: "14rem",
              forceSelection: false,
              selectedKey: "{ui>/poGRNStatusKey}",
              change: this.onPOFilterChange.bind(this),
              items: {
                path: "poVH>/grnStatus",
                template: new sap.ui.core.Item({
                  key: "{poVH>key}",
                  text: "{poVH>text}"
                })
              }
            });
          } else if (sField === "POVendorConfStatus") {
            oControl = new sap.m.Select({
              width: "16rem",
              forceSelection: false,
              selectedKey: "{ui>/poOutputStatusKey}",
              change: this.onPOFilterChange.bind(this),
              items: {
                path: "poVH>/outputStatus",
                template: new sap.ui.core.Item({
                  key: "{poVH>key}",
                  text: "{poVH>text}"
                })
              }
            });
          }
        } else {
          oControl = new sap.m.Input({
            width: "12rem",
            placeholder: "Enter " + this._labelForPOField(sField),
            valueLiveUpdate: true,
            liveChange: this.onPOQuickFilter.bind(this)
          });
        }

        if (!oControl) return;

        oControl.data("field", sField);

        const oFGI = new sap.ui.comp.filterbar.FilterGroupItem({
          name: sField,
          label: this._labelForPOField(sField),
          groupName: "Group1",
          visibleInFilterBar: bVisible,
          control: oControl
        });

        oFB.addFilterGroupItem(oFGI);
      }.bind(this));
    },

    _labelForPOField: function (sField) {
      const mLabels = {
        CreatedNo: "Created On",
        Plant: "Plant",
        Vendor: "Vendor Code",
        GRNStatus: "GRN Status",
        POVendorConfStatus: "PO Output Status",
        PODelDate: "PO Delivery Date",
        GRNDate: "GRN Date"
      };

      return mLabels[sField] || sField;
    },

    _applyPOFiltersFromFilterBar: function (mOpts) {
      mOpts = mOpts || {};
      const bReset = (mOpts.resetPage !== false);

      const oFB = this.byId("poFilterBar");
      const oPO = this.getView().getModel("poLocal");
      const oUI = this.getView().getModel("ui");
      if (!oFB || !oPO || !oUI) return;

      const aAll = oPO.getProperty("/allRows") || [];
      let aFiltered = aAll.slice();

      const aItems = oFB.getFilterGroupItems() || [];

      aItems.forEach(oItem => {
        const sField = oItem.getName();
        const oCtrl = oItem.getControl();
        if (!oCtrl) return;

        if (sField === "CreatedNo") return;

        if (oCtrl.isA("sap.m.DateRangeSelection")) {
          const dFrom = oCtrl.getDateValue();
          const dTo = oCtrl.getSecondDateValue();
          if (!dFrom && !dTo) return;

          const dStart = dFrom || dTo;
          const dEnd = dTo || dFrom;

          const sStart = this._fmtYYYYMMDD(dStart);
          const sEnd = this._fmtYYYYMMDD(dEnd);

          aFiltered = aFiltered.filter(r => {
            const v = String(r[sField] ?? "");
            return v && v >= sStart && v <= sEnd;
          });
          return;
        }

        // Input / ComboBox
        if (oCtrl.isA("sap.m.Input")) {
          const sVal = (oCtrl.getValue() || "").trim().toLowerCase();
          if (!sVal) return;

          aFiltered = aFiltered.filter(r =>
            String(r[sField] ?? "").toLowerCase().includes(sVal)
          );
          return;
        }

        // Select
        if (oCtrl.isA("sap.m.Select")) {
          const k = (oCtrl.getSelectedKey() || "").trim();
          if (!k) return;
          aFiltered = aFiltered.filter(r => String(r[sField] ?? "") === k);
          return;
        }
      });

      oPO.setProperty("/filteredRows", aFiltered);

      oPO.setProperty("/rows", aFiltered);

      oUI.setProperty("/selectedCountPO", 0);
      const oTable = this.byId("poTable");
      oTable?.clearSelection?.();
    },

    _showODataAsBackendMessages: function (err) {
      let msg = "Request failed";

      const rt =
        err?.error?.responseText ||
        err?.responseText ||
        err?.cause?.responseText ||
        err?.cause?.error?.responseText;

      if (rt) {
        try {
          const o = JSON.parse(rt);
          msg = o?.error?.message || msg;
        } catch (e) {
          msg = String(rt);
        }
      } else if (err?.message) {
        msg = err.message;
      }

      this._showBackendMessages([{ MsgType: "E", MsgText: msg }]);
    },

    onPOQuickFilter: function () {
      this._applyPOFiltersFromFilterBar({ resetPage: true });
      this._updatePOVisibleRowCount();

      const oTable = this.byId("poTable");
      oTable?.setFirstVisibleRow?.(0);
    },

    _isBenignODataV4Cancellation: function (e) {
      const msg =
        String(e?.message || "") +
        " " +
        String(e?.error?.message || "") +
        " " +
        String(e?.error?.responseText || "") +
        " " +
        String(e?.responseText || "");

      // casos típicos de OData V4/UI5 cuando una request queda obsoleta
      return (
        msg.includes("inactive cache") ||
        msg.includes("Request was cancelled") ||
        msg.includes("canceled") ||
        msg.includes("cancelled") ||
        msg.includes("aborted") ||
        msg.includes("AbortError")
      );
    },

    onPOFilterChange: async function (oEvent) {
      try {
        const oItem = oEvent?.getParameter("filterItem");
        const sName = oItem?.getName?.();

        if (sName === "CreatedNo") {
          await this._rebindPO();
        } else {
          this._applyPOFiltersFromFilterBar({ resetPage: true });
        }

        this._updatePOVisibleRowCount();
      } catch (e) {
        this._showODataAsBackendMessages(e);
      }
    },

    onPOAfterVariantLoad: async function () {
      try {
        await this._rebindPO();
        await this._updatePOVisibleRowCount();
      } catch (e) {
        this._showODataAsBackendMessages(e);
      }
    },

    onPOCreatedOnChange: function () {
      return this.onPOSearch();
    },

    onPOSearch: async function () {
      await this._rebindPO();
      await this._updatePOVisibleRowCount();
    },

    onRefreshPO: async function () {
      const oTable = this.byId("poTable");
      try {
        oTable?.setBusy(true);
        this._poUserTriggered = true;

        await this._rebindPO();
        await this._updatePOVisibleRowCount();

        MessageToast.show("POs refreshed");
      } catch (e) {
        if (this._isBenignODataV4Cancellation(e)) return;
        this._showODataAsBackendMessages(e);
      } finally {
        oTable?.setBusy(false);
      }
    },

    _setDefaultLast30DaysPO: function () {
      const oDRS = this.byId("poCreatedOn");
      if (!oDRS) return;

      if (oDRS.getDateValue?.() || oDRS.getSecondDateValue?.()) return;

      const to = new Date();
      const from = new Date(to);
      from.setDate(from.getDate() - 30);

      oDRS.setDateValue(from);
      oDRS.setSecondDateValue(to);
    },

    _refreshPO: async function () {
      const oTable = this.byId("poTable");
      oTable?.setBusy(true);
      try {
        await this._rebindPO();
        await this._updatePOVisibleRowCount?.();
      } finally {
        oTable?.setBusy(false);
      }
    },

    onExportPOsToExcel: async function () {
      const oTable = this.byId("poTable");
      if (!oTable) return;

      const oPO = this.getView().getModel("poLocal");
      const aRowsShown = oPO.getProperty("/rows") || []; // filtradas (lo que ves)

      if (!aRowsShown.length) {
        sap.m.MessageToast.show("No data to export.");
        return;
      }

      const aSelIdx = oTable.getSelectedIndices?.() || [];
      let aExportRows;

      if (aSelIdx.length > 0) {
        // indices son relativos a /rows (lo que se ve)
        aExportRows = aSelIdx.map(i => aRowsShown[i]).filter(Boolean);
        if (!aExportRows.length) {
          sap.m.MessageToast.show("Selection is empty.");
          return;
        }
      } else {
        aExportRows = aRowsShown;
      }

      const aExportRowsFinal = aExportRows.map(r => ({
        ...r,
        CreatedOnText: this.formatter.yyyymmddToDate(r.CreatedNo),
        PODelDateText: this.formatter.yyyymmddToDate(r.PODelDate),
        GRNDateText: this.formatter.yyyymmddToDate(r.GRNDate)
      }));

      const aCols = this._getPOExportColumns();

      const oSheet = new sap.ui.export.Spreadsheet({
        workbook: { columns: aCols },
        dataSource: aExportRowsFinal,
        fileName: aSelIdx.length > 0 ? "PO_Monitor_Selected.xlsx" : "PO_Monitor_Filtered.xlsx"
      });

      oSheet.build().finally(() => oSheet.destroy());
    },

    _getPOExportColumns: function () {
      return [
        { label: "PO", property: "PONumber" },
        { label: "Line", property: "LineNumber" },
        { label: "Material", property: "POMaterial" },
        { label: "Material Text", property: "MaterialPOText" },
        { label: "Purch. Org", property: "PurchaseOrg" },
        { label: "Order Type", property: "OrderType" },
        { label: "PO Qty", property: "POQty" },
        { label: "Plant", property: "Plant" },
        { label: "Created By", property: "CreatedBy" },
        { label: "Created On", property: "CreatedOnText" },
        { label: "Vendor", property: "Vendor" },
        { label: "Vendor Name", property: "VendorName" },
        { label: "Delivery Text", property: "DeliveryText" },
        { label: "PR", property: "PurReqNumber" },
        { label: "PR Item", property: "PurReqItemNo" },
        { label: "PR Qty", property: "PRQty" },
        { label: "PR Ordered", property: "PROrderedQty" },
        { label: "PR Balance", property: "PRBalanceQty" },
        { label: "Delv Comp", property: "DelvCompInd" },
        { label: "Scheduled", property: "ScheduledQty" },
        { label: "GRN Qty", property: "GRNQty" },
        { label: "GRN Status", property: "GRNStatus" },
        { label: "PO Del. Date", property: "PODelDateText" },
        { label: "GRN Date", property: "GRNDateText" },
        { label: "PO Output Status", property: "POVendorConfStatus" }
      ];
    },

    onPageSizeChange: function (oEvent) {
      var sKey = oEvent.getSource().getSelectedKey();
      var oUi = this.getView().getModel("ui");

      var vSize = (sKey === "ALL") ? "ALL" : parseInt(sKey, 10);
      oUi.setProperty("/pageSize", vSize);

      if (vSize !== "ALL") {
        this._applyPRPageSize(vSize);
      }

      oUi.setProperty("/pageIndex", 0);
      this._recalcPRPager();
      this._setPRPage(0);
    },

    onPOPageSizeChange: async function (oEvent) {
      const sKey = oEvent.getSource().getSelectedKey();
      const oUi = this.getView().getModel("ui");
      const oTable = this.byId("poTable");
      if (!oTable) return;

      const vSize = (sKey === "ALL") ? "ALL" : parseInt(sKey, 10);
      oUi.setProperty("/poPageSize", vSize);

      // Asegurá que el binding esté filtrado (y por ende cargado) antes de calcular filas
      await this._rebindPO();

      // Ajustá visibleRowCount a lo que realmente hay (evita filas en blanco)
      await this._updatePOVisibleRowCount();

      oTable.setFirstVisibleRow(0);
    },

    _updatePOVisibleRowCount: async function () {
      const oUi = this.getView().getModel("ui");
      const oPO = this.getView().getModel("poLocal");
      const vSize = oUi.getProperty("/poPageSize") || 10;

      const aRows = oPO.getProperty("/rows") || [];
      const iHave = aRows.length;

      const iVisible =
        (vSize === "ALL")
          ? Math.max(1, iHave)
          : Math.max(1, Math.min(Number(vSize), iHave));

      oUi.setProperty("/poVisibleRowCount", iVisible);
    },

    onFirstPage: function () {
      this._recalcPRPager();
      this._setPRPage(0);
    },

    onPrevPage: function () {
      var oUi = this.getView().getModel("ui");
      this._recalcPRPager();
      this._setPRPage((oUi.getProperty("/pageIndex") || 0) - 1);
    },

    onNextPage: function () {
      var oUi = this.getView().getModel("ui");
      this._recalcPRPager();
      this._setPRPage((oUi.getProperty("/pageIndex") || 0) + 1);
    },

    onLastPage: function () {
      var oUi = this.getView().getModel("ui");
      this._recalcPRPager();
      var iLast = (oUi.getProperty("/pageCount") || 1) - 1;
      this._setPRPage(iLast);
    },

    _getVariantScope: function () {
      return {
        appId: "prpo-services",
        tableId: "prTable"
      };
    },

    _loadPRVariants: async function () {
      const oVM = this.byId("prVariantMgmt");
      const oModel = this.getView().getModel();
      if (!oVM || !oModel) return;

      this._suppressVMEvents = true;  

      try {
        oVM.removeAllItems();

        const { appId, tableId } = this._getVariantScope();

        const oList = oModel.bindList("/VariantState", null, null, null, {
          $filter: `appId eq '${appId}' and tableId eq '${tableId}'`
        });

        const aCtx = await oList.requestContexts(0, 1);
        const oRow = aCtx[0]?.getObject();

        this._variantStateId = oRow?.ID || null;

        let oDoc;
        if (!oRow?.variantData) {
          oDoc = {
            variants: [{ key: "standard", title: "Standard", filters: {}, favorite: true, executeOnSelect: false, remove: false }],
            defaultKey: "standard",
            selectedKey: "standard"
          };
        } else {
          oDoc = JSON.parse(oRow.variantData);
        }

        this._variantDoc = oDoc;

        const aVariants = Array.isArray(oDoc.variants) ? oDoc.variants : [];
        aVariants.forEach(v => oVM.addItem(new VariantItem({ key: String(v.key), text: String(v.title || v.key) })));

        if (!aVariants.some(v => String(v.key) === "standard")) {
          oVM.addItem(new VariantItem({ key: "standard", text: "Standard" }));
        }

        if (oDoc.defaultKey) oVM.setDefaultVariantKey(String(oDoc.defaultKey));
        oVM.setCurrentVariantKey(String(oDoc.defaultKey || "standard"));

        // Aplicar filtros sin disparar persistencia
        const sSel = String(oDoc.defaultKey || "standard");
        const oSelVar = aVariants.find(v => String(v.key) === sSel);

        this._applyingVariant = true;
        try {
          if (oSelVar?.filters && Object.keys(oSelVar.filters).length > 0) {
            this._applyPRVariantStateFromDoc(oSelVar);
            await this._finalizePRVariantApply();
          } else {
            this._clearPRFilterState();
            this._pendingSimStatusFilter = null;
            this._applyPRFiltersFromFilterBar({ resetPage: true });
          }
        } finally {
          this._applyingVariant = false;
        }

      } finally {
        this._suppressVMEvents = false; 
      }
    },

  _clearPRFilterState: function () {
      const oUI = this.getView().getModel("ui");
      if (oUI) {
        oUI.setProperty("/simStatusFilter", "ALL");
        oUI.setProperty("/prStatusFilter", "ALL");
      }

      // Force the Select controls to update
      const oSimSelect = this._getPRFilterControlByName("SimStatus");
      if (oSimSelect && typeof oSimSelect.setSelectedKey === "function") {
        oSimSelect.setSelectedKey("ALL");
      }

      const oPRSelect = this._getPRFilterControlByName("PRStatus");
      if (oPRSelect && typeof oPRSelect.setSelectedKey === "function") {
        oPRSelect.setSelectedKey("ALL");
      }

      const aDefaultVisible = [
        "SimStatus",
        "PRStatus",
        "PurReqNumber",
        "MaterialNo",
        "PurchasingOrg",
        "MrpController"
      ];

      const oFB = this.byId("prFilterBar");
      if (!oFB) return;

      (oFB.getFilterGroupItems() || []).forEach((oItem) => {
        const sName = oItem.getName();
        const c = oItem.getControl();

        oItem.setVisibleInFilterBar(aDefaultVisible.includes(sName));

        if (!c) return;

        if (sName === "SimStatus" || sName === "PRStatus") return;

        if (c.isA("sap.m.DynamicDateRange")) {
          c.setValue(null);
          return;
        }

        if (c.isA("sap.m.DateRangeSelection")) {
          c.setDateValue(null);
          c.setSecondDateValue(null);
          return;
        }

        if (typeof c.setSelectedKey === "function") {
          c.setSelectedKey("");
          return;
        }

        if (typeof c.removeAllTokens === "function") {
          c.removeAllTokens();
        }
      });

      oFB.invalidate();
      sap.ui.getCore().applyChanges();
    },
    onPRVariantSave: async function (oEvent) {
      if (this._suppressVMEvents) return;

      const { appId, tableId } = this._getVariantScope();

      const sName = (oEvent.getParameter("name") || "").trim();
      const bDefault = !!oEvent.getParameter("def");

      const sKey = String(oEvent.getParameter("key") || "standard");

      const oDoc = await this._getVariantDoc();

      const oNewVar = {
        key: sKey,
        title: sName || "Standard",
        filters: this._collectPRVariantState(),
        favorite: true,
        executeOnSelect: false,
        remove: false
      };

      const a = oDoc.variants || [];
      const i = a.findIndex(v => String(v.key) === sKey);
      if (i >= 0) a[i] = oNewVar;
      else a.push(oNewVar);
      oDoc.variants = a;

      oDoc.selectedKey = sKey;
      if (bDefault) oDoc.defaultKey = sKey;

      await this._upsertVariantDoc(oDoc, appId, tableId);

      await this._loadPRVariants();
    },

    onPRVariantSelect: async function (oEvent) {
      if (this._suppressVMEvents || this._applyingVariant) return; 

      const sKey = String(oEvent.getParameter("key") || "");
      if (!sKey) return;

      const { appId, tableId } = this._getVariantScope();

      const oDoc = await this._getVariantDoc();
      oDoc.selectedKey = sKey;

      const a = oDoc.variants || [];
      const oVar = a.find(v => String(v.key) === sKey);

      this._applyingVariant = true;
      try {
        this._clearPRFilterState();

        if (oVar && oVar.filters && Object.keys(oVar.filters).length > 0) {
          this._applyPRVariantStateFromDoc(oVar);
          await this._finalizePRVariantApply();
        } else {
          this._pendingSimStatusFilter = null;
          this._applyPRFiltersFromFilterBar({ resetPage: true });
        }
      } finally {
        this._applyingVariant = false;
      }

      await this._upsertVariantDoc(oDoc, appId, tableId);
    },

    onPRVariantManage: async function (oEvent) {
      if (this._suppressVMEvents) return;
      const aDeleted = oEvent.getParameter("deleted") || []; // keys
      if (!aDeleted.length) return;

      const { appId, tableId } = this._getVariantScope();

      const oDoc = await this._getVariantDoc();
      const a = oDoc.variants || [];

      oDoc.variants = a.filter(v => !aDeleted.includes(String(v.key)));

      if (aDeleted.includes(String(oDoc.defaultKey))) oDoc.defaultKey = "standard";
      if (aDeleted.includes(String(oDoc.selectedKey))) oDoc.selectedKey = "standard";

      await this._upsertVariantDoc(oDoc, appId, tableId);
      await this._loadPRVariants();
    },
    
    _getVariantDoc: async function () {
      if (this._variantDoc) return this._variantDoc;

      await this._loadPRVariants();

      return this._variantDoc || {
        variants: [{ key: "standard", title: "Standard", filters: {}, favorite: true, executeOnSelect: false, remove: false }],
        defaultKey: "standard",
        selectedKey: "standard"
      };
    },

    _upsertVariantDoc: async function (oDoc, appId, tableId) {
      const oModel = this.getView().getModel();
      const oList = oModel.bindList("/VariantState");

      const oCtx = oList.create({ appId, tableId, variantData: JSON.stringify(oDoc) });
      await oCtx.created(); 

      this._variantDoc = oDoc;
    },

    _applyPRVariantStateFromDoc: function (oVar) {
      const s = JSON.stringify(oVar.filters || {});
      this._applyPRVariantData(s);
    },

    _getPRFilterControlByName: function (sName) {
      const oFB = this.byId("prFilterBar");
      if (!oFB?.getFilterGroupItems) return null;

      const oItem = (oFB.getFilterGroupItems() || []).find(i => i.getName && i.getName() === sName);
      return oItem?.getControl ? oItem.getControl() : null;
    },

    _applyPRVariantData: function (vFilters) {
      let o;
      try {
        o = typeof vFilters === "string" ? JSON.parse(vFilters || "{}") : (vFilters || {});
      } catch (e) {
        console.warn("Invalid variant JSON:", vFilters, e);
        return;
      }

      this._clearPRFilterState();

      const oUI = this.getView().getModel("ui");
      this._pendingSimStatusFilter = o.ui?.simStatusFilter ?? "ALL";

      oUI.setProperty("/simStatusFilter", "ALL");
      if (o.ui?.prStatusFilter != null) {
        oUI.setProperty("/prStatusFilter", o.ui.prStatusFilter);
      }

      const oFB = this.byId("prFilterBar");
      if (oFB && Array.isArray(o.visibleFilters)) {
        const aVisible = new Set(o.visibleFilters);
        (oFB.getFilterGroupItems() || []).forEach((oItem) => {
          const sName = oItem.getName();
          oItem.setVisibleInFilterBar(aVisible.has(sName));
        });
      }

      const fb = o.fb || {};
      Object.keys(fb).forEach((sField) => {
        const c = this._getPRFilterControlByName(sField);
        if (!c) return;

        if (c.isA("sap.m.DateRangeSelection")) {
          c.setDateValue(fb[sField].from ? new Date(fb[sField].from) : null);
          c.setSecondDateValue(fb[sField].to ? new Date(fb[sField].to) : null);
          return;
        }

        if (typeof c.setValue === "function") {
          c.setValue(fb[sField]?.value ?? "");
          return;
        }

        if (typeof c.setSelectedKey === "function") {
          c.setSelectedKey(fb[sField]?.key ?? "");
        }
      });

      this._applyPRFiltersFromFilterBar({ resetPage: true, skipAutoSim: true });
    },

    _finalizePRVariantApply: async function () {
      const oUI = this.getView().getModel("ui");
      const sPendingSim = this._pendingSimStatusFilter || "ALL";

      if (sPendingSim !== "ALL") {
        await this._simulateFilteredRows();
      }

      oUI.setProperty("/simStatusFilter", sPendingSim);
      this._pendingSimStatusFilter = null;

      this._applyPRFiltersFromFilterBar({ resetPage: true, skipAutoSim: true });
    },

    _collectPRVariantState: function () {
      const oUI = this.getView().getModel("ui");
      const oFB = this.byId("prFilterBar");

      const state = {
        ui: {
          simStatusFilter: oUI?.getProperty("/simStatusFilter") ?? "ALL",
          prStatusFilter:  oUI?.getProperty("/prStatusFilter")  ?? "ALL"
        },
        fb: {},
        visibleFilters: []
      };

      if (!oFB?.getFilterGroupItems) return state;

      (oFB.getFilterGroupItems() || []).forEach((oItem) => {
        const sField = oItem.getName();
        const c = oItem.getControl();
        if (!sField || !c) return;

        if (oItem.getVisibleInFilterBar()) {
          state.visibleFilters.push(sField);
        }

        if (sField === "SimStatus" || sField === "PRStatus") return;

        if (c.isA && c.isA("sap.m.DateRangeSelection")) {
          const from = c.getDateValue ? (c.getDateValue()?.toISOString() || null) : null;
          const to   = c.getSecondDateValue ? (c.getSecondDateValue()?.toISOString() || null) : null;

          if (from || to) state.fb[sField] = { from, to };
          return;
        }

        if (typeof c.getValue === "function") {
          const v = (c.getValue() || "").trim();
          if (v) state.fb[sField] = { value: v };
          return;
        }

        if (typeof c.getSelectedKey === "function") {
          const k = c.getSelectedKey();
          if (k != null && String(k).trim() !== "") state.fb[sField] = { key: String(k) };
          return;
        }

        if (typeof c.getTokens === "function") {
          const a = c.getTokens() || [];
          const values = a
            .map(t => (t.getKey && t.getKey()) || (t.getText && t.getText()) || "")
            .map(x => String(x).trim())
            .filter(Boolean);
          if (values.length) state.fb[sField] = { values };
          return;
        }
      });

      return state;
    },

    _simulateAllRows: async function () {
      const oPR = this.getView().getModel("prLocal");
      const aAll = oPR.getProperty("/allRows") || [];

      if (!aAll.length) return;

      this.getView().getModel("ui").setProperty("/busySim", true);

      try {
        for (const r of aAll) {
          if (r.SimulationState === "DONE") continue;

          const key = this._makeKey(r);
          const cached = this._simCache.get(key);
          if (cached?.SimulationState === "DONE") {
            r.SimulationState = cached.SimulationState;
            r.SimulationError = cached.SimulationError;
            r.SimulationWarn  = cached.SimulationWarn;
            r.SimulationLogs  = cached.SimulationLogs ? cached.SimulationLogs.slice() : [];
            continue;
          }

          // Build payload and simulate
          const oFull = this._buildPRToPOItem(r);

          try {
            const aReturn = await this._executeCatalogAction("prSimulateMultiple", {
              Items: [oFull]
            });

            const aLogs = (aReturn || []).map(m => ({
              type: m.MsgType || "I",
              text: m.MsgText || ""
            }));

            const bError = aLogs.some(l => l.type === "E" || l.type === "A");
            const bWarn  = !bError && aLogs.some(l => l.type === "W");

            r.SimulationState = "DONE";
            r.SimulationError = bError;
            r.SimulationWarn  = bWarn;
            r.SimulationLogs  = aLogs;

            this._simCache.set(key, {
              SimulationState: "DONE",
              SimulationError: bError,
              SimulationWarn: bWarn,
              SimulationLogs: aLogs.slice()
            });

          } catch (e) {
            r.SimulationState = "DONE";
            r.SimulationError = true;
            r.SimulationWarn  = false;
            r.SimulationLogs  = [{ type: "E", text: "Simulation failed: " + (e?.message || e) }];

            this._simCache.set(key, {
              SimulationState: "DONE",
              SimulationError: true,
              SimulationWarn: false,
              SimulationLogs: r.SimulationLogs.slice()
            });
          }
        }

        oPR.setProperty("/allRows", aAll);

      } finally {
        this.getView().getModel("ui").setProperty("/busySim", false);
      }
    },

    _applyStartupKpiType: async function () {
      if (this._startupApplied) return;
      if (!this._startupKpiType) return;

      this._startupApplied = true;

      switch (this._startupKpiType) {
        case "PR_FAILED":
          await this._applyPRKpiFilters({ simStatus: "ERROR", prStatus: "OPEN" });
          break;

        case "PR_SUCCESS":
          await this._applyPRKpiFilters({ simStatus: "SUCCESS", prStatus: "OPEN" });
          break;

        case "OPEN_PR":
          await this._applyPRKpiFilters({ simStatus: "ALL", prStatus: "OPEN" });
          break;

        case "OPEN_PO":
          await this._applyPOKpiOpen();
          break;

        case "CONVERTED_POS":
          await this._applyPOKpiConverted();
          break;

        case "IBP_PRS":
          this._applyPRKpiIbpOnly();
          break;

        default:
          break;
      }
    },

    _applyPRKpiFilters: async function ({ simStatus, prStatus }) {
      var oTab = this.byId("tabBar");
      if (oTab) oTab.setSelectedKey("PR");

      var oUi = this.getView().getModel("ui");
      var oFB = this.byId("prFilterBar");

      if (oFB) {
        (oFB.getFilterGroupItems() || []).forEach(function (oItem) {
          var sName = oItem.getName();
          if (sName === "SimStatus" || sName === "PRStatus") {
            oItem.setVisibleInFilterBar(true);
          }
        });
        oFB.invalidate();
      }

      sap.ui.getCore().applyChanges();

      oUi.setProperty("/prStatusFilter", prStatus || "ALL");
      oUi.setProperty("/simStatusFilter", "ALL");

      this._applyPRFiltersFromFilterBar({ resetPage: true, skipAutoSim: true });

      if (simStatus === "SUCCESS" || simStatus === "ERROR") {
        await this._simulateFilteredRows();
      }

      oUi.setProperty("/simStatusFilter", simStatus || "ALL");
      this._applyPRFiltersFromFilterBar({ resetPage: true, skipAutoSim: true });
    },

    _applyPOKpiOpen: async function () {
      var oTab = this.byId("tabBar");
      if (oTab) oTab.setSelectedKey("PO");
      sap.ui.getCore().applyChanges();

      this._setDefaultLast30DaysPO();

      var oTable = this.byId("poTable");
      oTable && oTable.setBusy(true);

      try {
        await this._rebindPO();

        var norm = function (s) {
          return String(s ?? "").trim().toUpperCase();
        };

        var oPO = this.getView().getModel("poLocal");
        var aAll = oPO.getProperty("/allRows") || [];

        var aOpen = aAll.filter(function (r) {
          var st = norm(r && r.GRNStatus);
          return st === "OPEN";
        });

        oPO.setProperty("/filteredRows", aOpen);
        oPO.setProperty("/rows", aOpen);

        await this._updatePOVisibleRowCount();
      } finally {
        oTable && oTable.setBusy(false);
      }
    },

    _applyPOKpiConverted: async function () {
      var oTab = this.byId("tabBar");
      if (oTab) oTab.setSelectedKey("PO");

      sap.ui.getCore().applyChanges();

      this._setDefaultLast30DaysPO();

      var oTable = this.byId("poTable");
      oTable && oTable.setBusy(true);

      try {
        await this._rebindPO();

        var oPO = this.getView().getModel("poLocal");
        var aAll = oPO.getProperty("/allRows") || [];

        var aConverted = aAll.filter(function (r) {
          var pr = String(r?.PurReqNumber || "").trim();
          var po = String(r?.PONumber || "").trim();
          return !!pr && !!po;
        });

        oPO.setProperty("/filteredRows", aConverted);
        oPO.setProperty("/rows", aConverted);

        await this._updatePOVisibleRowCount();
      } finally {
        oTable && oTable.setBusy(false);
      }
    },

    _applyPRKpiIbpOnly: function () {
      var oTab = this.byId("tabBar");
      if (oTab) oTab.setSelectedKey("PR");

      var oPR = this.getView().getModel("prLocal");
      var aAll = oPR.getProperty("/allRows") || [];

      var aFiltered = aAll.filter(function (r) {
        return String(r?.CreatedByUser || "")
          .trim()
          .toUpperCase()
          .startsWith("IBP");
      });

      oPR.setProperty("/filteredRows", aFiltered);

      var oUI = this.getView().getModel("ui");
      oUI.setProperty("/pageIndex", 0);

      this._recalcPRPager();
      this._setPRPage(0);
    },

    _enqueuePRSimulation: function (fn) {
      const oUI = this.getView().getModel("ui");

      const run = async () => {
        this._simBusy = true;
        oUI.setProperty("/busySim", true);

        try {
          return await fn();
        } finally {
          this._simBusy = false;
          oUI.setProperty("/busySim", false);
          this._reapplySimDependentFilters();
        }
      };

      this._simQueue = (this._simQueue || Promise.resolve()).then(run, run);
      return this._simQueue;
    },

    _reapplySimDependentFilters: function () {
      const oUI = this.getView().getModel("ui");
      const sSim = oUI.getProperty("/simStatusFilter") || "ALL";
      const sPending = this._pendingSimStatusFilter || "ALL";

      if (sSim !== "ALL" || sPending !== "ALL") {
        this._applyPRFiltersFromFilterBar({
          resetPage: false,
          skipAutoSim: true
        });
      } else {
        this.getView().getModel("prLocal")?.refresh(true);
      }
    },

    _getPOFilterControlByName: function (sName) {
      const oFB = this.byId("poFilterBar");
      if (!oFB?.getFilterGroupItems) return null;

      const oItem = (oFB.getFilterGroupItems() || []).find(i => i.getName && i.getName() === sName);
      return oItem?.getControl ? oItem.getControl() : null;
    },

    _clearPOFilterState: function () {
      const oUI = this.getView().getModel("ui");
      if (oUI) {
        oUI.setProperty("/poGRNStatusKey", "");
        oUI.setProperty("/poOutputStatusKey", "");
      }

      const oFB = this.byId("poFilterBar");
      if (!oFB) return;

      const aDefaultVisible = [
        "CreatedNo",
        "Plant",
        "Vendor",
        "GRNStatus",
        "POVendorConfStatus"
      ];

      (oFB.getFilterGroupItems() || []).forEach((oItem) => {
        const sName = oItem.getName();
        const c = oItem.getControl();

        oItem.setVisibleInFilterBar(aDefaultVisible.includes(sName));
        if (!c) return;

        if (c.isA("sap.m.DateRangeSelection")) {
          c.setDateValue(null);
          c.setSecondDateValue(null);
          return;
        }

        if (typeof c.setSelectedKey === "function") {
          c.setSelectedKey("");
          return;
        }

        if (typeof c.setValue === "function") {
          c.setValue("");
        }
      });

      this._setDefaultLast30DaysPO();
      sap.ui.getCore().applyChanges();
    },

    _collectPOVariantState: function () {
      const oFB = this.byId("poFilterBar");

      const state = {
        fb: {},
        visibleFilters: []
      };

      if (!oFB?.getFilterGroupItems) return state;

      sap.ui.getCore().applyChanges();

      (oFB.getFilterGroupItems() || []).forEach((oItem) => {
        const sField = oItem.getName();
        const c = oItem.getControl();
        if (!sField || !c) return;

        if (oItem.getVisibleInFilterBar()) {
          state.visibleFilters.push(sField);
        }

        if (c.isA && c.isA("sap.m.DateRangeSelection")) {
          const from = c.getDateValue ? (c.getDateValue()?.toISOString() || null) : null;
          const to = c.getSecondDateValue ? (c.getSecondDateValue()?.toISOString() || null) : null;

          if (from || to) {
            state.fb[sField] = { from, to };
          }
          return;
        }

        if (c.isA && c.isA("sap.m.Select")) {
          const k = (c.getSelectedKey?.() || "").trim();
          if (k) {
            state.fb[sField] = { key: k };
          }
          return;
        }

        if (c.isA && c.isA("sap.m.Input")) {
          const v = String(
            (typeof c.getDOMValue === "function" ? c.getDOMValue() : c.getValue?.()) || ""
          ).trim();

          if (v) {
            state.fb[sField] = { value: v };
          }
          return;
        }

        if (typeof c.getValue === "function") {
          const v = String(c.getValue() || "").trim();
          if (v) {
            state.fb[sField] = { value: v };
          }
        }
      });

      return state;
    },

    _applyPOVariantData: async function (vFilters) {
      let o;
      try {
        o = typeof vFilters === "string" ? JSON.parse(vFilters || "{}") : (vFilters || {});
      } catch (e) {
        console.warn("Invalid PO variant JSON:", vFilters, e);
        return;
      }

      this._clearPOFilterState();

      await this._rebindPO();

      const oFB = this.byId("poFilterBar");
      if (oFB && Array.isArray(o.visibleFilters)) {
        const aVisible = new Set(o.visibleFilters);
        (oFB.getFilterGroupItems() || []).forEach((oItem) => {
          oItem.setVisibleInFilterBar(aVisible.has(oItem.getName()));
        });
      }

      const fb = o.fb || {};
      Object.keys(fb).forEach((sField) => {
        const c = this._getPOFilterControlByName(sField);
        if (!c) return;

        if (c.isA && c.isA("sap.m.DateRangeSelection")) {
          c.setDateValue(fb[sField].from ? new Date(fb[sField].from) : null);
          c.setSecondDateValue(fb[sField].to ? new Date(fb[sField].to) : null);
          return;
        }

        if (c.isA && c.isA("sap.m.Select")) {
          c.setSelectedKey(fb[sField]?.key ?? "");
          return;
        }

        if (c.isA && c.isA("sap.m.Input")) {
          c.setValue(fb[sField]?.value ?? "");
        }
      });

      sap.ui.getCore().applyChanges();

      this._applyPOFiltersFromFilterBar({ resetPage: true });
      await this._updatePOVisibleRowCount();
    },

    _getPOVariantScope: function () {
      return {
        appId: "prpo-services",
        tableId: "poTable"
      };
    },

    _getPOVariantDoc: async function () {
      if (this._poVariantDoc) return this._poVariantDoc;

      await this._loadPOVariants();

      return this._poVariantDoc || {
        variants: [{ key: "standard", title: "Standard", filters: {}, favorite: true, executeOnSelect: false, remove: false }],
        defaultKey: "standard",
        selectedKey: "standard"
      };
    },

    _upsertPOVariantDoc: async function (oDoc) {
      const { appId, tableId } = this._getPOVariantScope();
      const oModel = this.getView().getModel();
      const oList = oModel.bindList("/VariantState");

      const oCtx = oList.create({
        appId,
        tableId,
        variantData: JSON.stringify(oDoc)
      });
      await oCtx.created();

      this._poVariantDoc = oDoc;
    },

    _loadPOVariants: async function () {
      const oVM = this.byId("poVariantMgmt");
      const oModel = this.getView().getModel();
      if (!oVM || !oModel) return;

      this._suppressPOVMEvents = true;

      try {
        oVM.removeAllItems();

        const { appId, tableId } = this._getPOVariantScope();

        const oList = oModel.bindList("/VariantState", null, null, null, {
          $filter: `appId eq '${appId}' and tableId eq '${tableId}'`
        });

        const aCtx = await oList.requestContexts(0, 1);
        const oRow = aCtx[0]?.getObject();

        let oDoc;
        if (!oRow?.variantData) {
          oDoc = {
            variants: [{ key: "standard", title: "Standard", filters: {}, favorite: true, executeOnSelect: false, remove: false }],
            defaultKey: "standard",
            selectedKey: "standard"
          };
        } else {
          oDoc = JSON.parse(oRow.variantData);
        }

        this._poVariantDoc = oDoc;

        const aVariants = Array.isArray(oDoc.variants) ? oDoc.variants : [];
        aVariants.forEach(v => {
          oVM.addItem(new VariantItem({
            key: String(v.key),
            text: String(v.title || v.key)
          }));
        });

        if (!aVariants.some(v => String(v.key) === "standard")) {
          oVM.addItem(new VariantItem({ 
            key: "standard", 
            text: "Standard"
          }));
        }

        if (oDoc.defaultKey) oVM.setDefaultVariantKey(String(oDoc.defaultKey));
        oVM.setCurrentVariantKey(String(oDoc.selectedKey || oDoc.defaultKey || "standard"));

        const sSel = String(oDoc.selectedKey || oDoc.defaultKey || "standard");
        const oSelVar = aVariants.find(v => String(v.key) === sSel);

        if (!this._poFiltersBuilt) {
          this._clearPOFilterState();
          await this._rebindPO(); // construye filtros dinámicos
        }

        if (oSelVar?.filters && Object.keys(oSelVar.filters).length > 0) {
          await this._applyPOVariantData(oSelVar.filters);
        } else {
          this._clearPOFilterState();
          await this._rebindPO();
          this._applyPOFiltersFromFilterBar({ resetPage: true });
          await this._updatePOVisibleRowCount();
        }
      } finally {
        this._suppressPOVMEvents = false;
      }
    },

    onPOVariantSave: async function (oEvent) {
      if (this._suppressPOVMEvents) return;

      const sName = (oEvent.getParameter("name") || "").trim();
      const bDefault = !!oEvent.getParameter("def");
      const sKey = String(oEvent.getParameter("key") || "standard");

      const oDoc = await this._getPOVariantDoc();

      const oVendor = this._getPOFilterControlByName("Vendor");
      
      const oNewVar = {
        key: sKey,
        title: sName || "Standard",
        filters: this._collectPOVariantState(),
        favorite: true,
        executeOnSelect: false,
        remove: false
      };

      const a = oDoc.variants || [];
      const i = a.findIndex(v => String(v.key) === sKey);
      if (i >= 0) a[i] = oNewVar;
      else a.push(oNewVar);

      oDoc.variants = a;
      oDoc.selectedKey = sKey;
      if (bDefault) oDoc.defaultKey = sKey;

      await this._upsertPOVariantDoc(oDoc);
      await this._loadPOVariants();
    },

    onPOVariantSelect: async function (oEvent) {
      if (this._suppressPOVMEvents) return;

      const sKey = String(oEvent.getParameter("key") || "");
      if (!sKey) return;

      const oDoc = await this._getPOVariantDoc();
      oDoc.selectedKey = sKey;

      const oVar = (oDoc.variants || []).find(v => String(v.key) === sKey);

      if (oVar?.filters) {
        await this._applyPOVariantData(oVar.filters);
      } else {
        this._clearPOFilterState();
        await this._rebindPO();
        this._applyPOFiltersFromFilterBar({ resetPage: true });
        await this._updatePOVisibleRowCount();
      }

      await this._upsertPOVariantDoc(oDoc);
    },

    onPOVariantManage: async function (oEvent) {
      if (this._suppressPOVMEvents) return;

      const aDeleted = oEvent.getParameter("deleted") || [];
      if (!aDeleted.length) return;

      const oDoc = await this._getPOVariantDoc();
      oDoc.variants = (oDoc.variants || []).filter(v => !aDeleted.includes(String(v.key)));

      if (aDeleted.includes(String(oDoc.defaultKey))) oDoc.defaultKey = "standard";
      if (aDeleted.includes(String(oDoc.selectedKey))) oDoc.selectedKey = "standard";

      await this._upsertPOVariantDoc(oDoc);
      await this._loadPOVariants();
    },

  });
});