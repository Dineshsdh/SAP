import cds from '@sap/cds';

// Known email sender segments used to identify BU and region
const KNOWN_BUS = ['taste', 'scent', 'hb', 'fi'];
const KNOWN_REGIONS = ['emea', 'latam', 'aspac', 'na'];
const ENV_SUFFIXES = ['dev', 'qas'];

const DEFAULT_PAGE_SIZE = 100;
// Adjust this constant if the actual rejected status value in the DB differs
const REJECTED_STATUS = 'Rejected';

// ─── Utility helpers ──────────────────────────────────────────────────────────

/**
 * Parses an IFF CSR inbox email to extract business unit and region.
 * Pattern: orders{BU}[{REGION}][dev|qas]@iff.com
 * Examples:
 *   ordershbemeaqas@iff.com  → bu=hb, region=emea
 *   ordersfilatam@iff.com    → bu=fi, region=latam
 *   orderstastedev@iff.com   → bu=taste, region=null
 */
function parseEmailSender(emailSender) {
  if (!emailSender) return { bu: null, region: null };

  const localPart = emailSender.toLowerCase().split('@')[0];
  if (!localPart.startsWith('orders')) return { bu: null, region: null };

  let remainder = localPart.slice('orders'.length);

  let bu = null;
  for (const knownBU of KNOWN_BUS) {
    if (remainder.startsWith(knownBU)) {
      bu = knownBU;
      remainder = remainder.slice(knownBU.length);
      break;
    }
  }

  for (const suffix of ENV_SUFFIXES) {
    if (remainder.endsWith(suffix)) {
      remainder = remainder.slice(0, -suffix.length);
      break;
    }
  }

  let region = null;
  for (const knownRegion of KNOWN_REGIONS) {
    if (remainder === knownRegion) {
      region = knownRegion;
      break;
    }
  }

  return { bu, region };
}

function buildDateRangeISO(dateFrom, dateTo) {
  const from = new Date(dateFrom);
  const to = new Date(dateTo);

  if (isNaN(from.getTime())) throw new Error(`Invalid dateFrom: ${dateFrom}`);
  if (isNaN(to.getTime())) throw new Error(`Invalid dateTo: ${dateTo}`);

  from.setHours(0, 0, 0, 0);
  to.setHours(23, 59, 59, 999);

  return { fromISO: from.toISOString(), toISO: to.toISOString() };
}

/** Returns the difference between two timestamps in hours, rounded to 2 decimals. */
function calcHours(createdAt, completedAt) {
  if (!createdAt || !completedAt) return null;
  const diff = new Date(completedAt) - new Date(createdAt);
  if (isNaN(diff) || diff < 0) return null;
  return parseFloat((diff / 3600000).toFixed(2));
}

/**
 * Post-filters an array of documents (already enriched with _bu / _region)
 * by location, region and/or BU. All filters are case-insensitive.
 */
function applyDimensionFilters(docs, { location, region, bu } = {}) {
  if (location && location.length > 0) {
    const set = new Set(location.map(l => l.toLowerCase()));
    docs = docs.filter(d => d.emailSender && set.has(d.emailSender.toLowerCase()));
  }
  if (region && region.length > 0) {
    const set = new Set(region.map(r => r.toLowerCase()));
    docs = docs.filter(d => d._region && set.has(d._region.toLowerCase()));
  }
  if (bu && bu.length > 0) {
    const set = new Set(bu.map(b => b.toLowerCase()));
    docs = docs.filter(d => d._bu && set.has(d._bu.toLowerCase()));
  }
  return docs;
}

/** Returns the grouping key for a document given a KPI dimension (1=location, 2=region, 3=BU). */
function getDimensionKey(doc, kpiId) {
  if (kpiId === 1) return doc.emailSender || 'unknown';
  if (kpiId === 2) return doc._region || 'unknown';
  return doc._bu || 'unknown';
}

/** Slices an array for the requested page and wraps it with pagination metadata. */
function paginate(rows, page, pageSize) {
  const p = Math.max(1, parseInt(page) || 1);
  const ps = Math.max(1, parseInt(pageSize) || DEFAULT_PAGE_SIZE);
  const total = rows.length;
  return {
    data: rows.slice((p - 1) * ps, p * ps),
    total,
    page: p,
    pageSize: ps,
    totalPages: Math.ceil(total / ps)
  };
}

// ─── Core DB queries ──────────────────────────────────────────────────────────

/**
 * Runs the base Documents query with date range and optional SQL-level filters.
 * Returns { db, docs }.
 *
 * sqlFilters:
 *   rejectedOnly   – adds status = REJECTED_STATUS to WHERE
 *   automationType – array of creationType values to include (SQL IN filter)
 */
async function queryDocuments(dateFrom, dateTo, sqlFilters = {}) {
  const { fromISO, toISO } = buildDateRangeISO(dateFrom, dateTo);
  const db = await cds.connect.to('db');
  const { Documents } = cds.entities('soautomation');

  const where = [
    { ref: ['deleted'] }, 'is not', { val: true },
    'and', { ref: ['system'] }, '!=', { val: 'PR1' },
    'and', { ref: ['createdAt'] }, '>=', { val: fromISO },
    'and', { ref: ['createdAt'] }, '<=', { val: toISO }
  ];

  if (sqlFilters.rejectedOnly) {
    where.push('and', { ref: ['status'] }, '=', { val: REJECTED_STATUS });
  }

  if (sqlFilters.automationType && sqlFilters.automationType.length > 0) {
    where.push('and', { ref: ['creationType'] }, 'in', {
      list: sqlFilters.automationType.map(v => ({ val: v }))
    });
  }

  const q = SELECT.from(Documents).columns(
    'ID', 'LogId', 'emailSender', 'createdAt', 'completedAt',
    'status', 'creationType', 'cancelReason'
  );
  q.SELECT.where = where;

  return { db, docs: await db.run(q) };
}

/**
 * Fetches DocumentHeaderStats for the given document IDs.
 * Returns { poMap, hsMap } keyed by documentID_ID.
 */
async function queryHeaderStats(db, docIds) {
  const { DocumentHeaderStats } = cds.entities('soautomation');
  const idList = { list: docIds.map(id => ({ val: id })) };
  const q = SELECT.from(DocumentHeaderStats).columns(
    'documentID_ID', 'purchaseOrderNumber', 'SAPNetVal', 'SAPCurrencyCode'
  );
  q.SELECT.where = [{ ref: ['documentID_ID'] }, 'in', idList];

  const rows = await db.run(q);
  const poMap = {}, hsMap = {};
  for (const r of rows || []) {
    if (!poMap[r.documentID_ID] && r.purchaseOrderNumber) poMap[r.documentID_ID] = r.purchaseOrderNumber;
    if (!hsMap[r.documentID_ID]) hsMap[r.documentID_ID] = r;
  }
  return { poMap, hsMap };
}

/**
 * Fetches DocumentLineItems for the given document IDs.
 * Returns { soMap, liMap } keyed by documentID_ID.
 *   soMap – Set of unique SalesOrder values per document
 *   liMap – array of line item rows per document
 */
async function queryLineItems(db, docIds) {
  const { DocumentLineItems } = cds.entities('soautomation');
  const idList = { list: docIds.map(id => ({ val: id })) };
  const q = SELECT.from(DocumentLineItems).columns(
    'documentID_ID', 'itemNumber', 'SalesOrder',
    'netAmount', 'currencyCode', 'completedAt', 'quantity'
  );
  q.SELECT.where = [{ ref: ['documentID_ID'] }, 'in', idList];

  const rows = await db.run(q);
  const soMap = {}, liMap = {};
  for (const r of rows || []) {
    if (r.SalesOrder) {
      if (!soMap[r.documentID_ID]) soMap[r.documentID_ID] = new Set();
      soMap[r.documentID_ID].add(r.SalesOrder);
    }
    if (!liMap[r.documentID_ID]) liMap[r.documentID_ID] = [];
    liMap[r.documentID_ID].push(r);
  }
  return { soMap, liMap };
}

// ─── High-level fetch functions ───────────────────────────────────────────────

/**
 * Fetches documents enriched with header stats and full line items.
 * Used by detail actions (KPI_Orders_Detail, KPI_Rejected_Detail).
 *
 * filters:
 *   location      – array of emailSender values
 *   region        – array of region names
 *   bu            – array of business unit names
 *   automationType– array of creationType values (SQL-level filter)
 *   rejectedOnly  – boolean, adds SQL WHERE status = REJECTED_STATUS
 *   reason        – array of cancelReason values (post-filter)
 */
async function fetchDetailDocuments(dateFrom, dateTo, filters = {}) {
  if (!dateFrom || !dateTo) throw new Error('dateFrom and dateTo are required');

  const { db, docs } = await queryDocuments(dateFrom, dateTo, {
    rejectedOnly: filters.rejectedOnly,
    automationType: filters.automationType
  });
  if (!docs || docs.length === 0) return [];

  // Enrich with parsed email dimensions for in-memory filtering
  let enriched = docs.map(d => {
    const { bu, region } = parseEmailSender(d.emailSender);
    return { ...d, _bu: bu, _region: region };
  });

  enriched = applyDimensionFilters(enriched, filters);
  if (enriched.length === 0) return [];

  // Apply rejection reason filter early to reduce the IDs sent to DB
  if (filters.reason && filters.reason.length > 0) {
    const reasonSet = new Set(filters.reason.map(r => r.toLowerCase()));
    enriched = enriched.filter(d => d.cancelReason && reasonSet.has(d.cancelReason.toLowerCase()));
    if (enriched.length === 0) return [];
  }

  const docIds = enriched.map(d => d.ID);
  const [{ poMap, hsMap }, { soMap, liMap }] = await Promise.all([
    queryHeaderStats(db, docIds),
    queryLineItems(db, docIds)
  ]);

  return enriched.map(doc => ({
    logId: doc.LogId,
    emailSender: doc.emailSender,
    createdAt: doc.createdAt,
    completedAt: doc.completedAt,
    status: doc.status,
    creationType: doc.creationType,
    cancelReason: doc.cancelReason,
    region: doc._region,
    businessUnit: doc._bu,
    purchaseOrder: poMap[doc.ID] || null,
    netAmount: hsMap[doc.ID] ? hsMap[doc.ID].SAPNetVal : null,
    currencyCode: hsMap[doc.ID] ? hsMap[doc.ID].SAPCurrencyCode : null,
    salesOrders: soMap[doc.ID] ? [...soMap[doc.ID]] : [],
    lineItems: liMap[doc.ID] || []
  }));
}

/**
 * Fetches documents for aggregate KPIs (no header stats or line item detail).
 * When linesMode=true, also fetches line items to count positions per document.
 *
 * Each returned object has _bu, _region, and optionally _lineCount.
 */
async function fetchAggregateDocuments(dateFrom, dateTo, filters = {}, linesMode = false) {
  if (!dateFrom || !dateTo) throw new Error('dateFrom and dateTo are required');

  const { db, docs } = await queryDocuments(dateFrom, dateTo, {
    rejectedOnly: filters.rejectedOnly,
    automationType: filters.automationType
  });
  if (!docs || docs.length === 0) return [];

  let enriched = docs.map(d => {
    const { bu, region } = parseEmailSender(d.emailSender);
    return { ...d, _bu: bu, _region: region };
  });

  enriched = applyDimensionFilters(enriched, filters);
  if (enriched.length === 0 || !linesMode) return enriched;

  const docIds = enriched.map(d => d.ID);
  const { liMap } = await queryLineItems(db, docIds);
  return enriched.map(d => ({ ...d, _lineCount: (liMap[d.ID] || []).length }));
}

// ─── Response formatters ──────────────────────────────────────────────────────

/**
 * Formats a single document as a header-level detail row.
 * Fields left empty per spec: location, automationType, changedFields, split.
 */
function formatHeaderRow(doc) {
  return {
    logId: doc.logId,
    status: doc.status,
    createdAt: doc.createdAt,
    completedAt: doc.completedAt,
    hours: calcHours(doc.createdAt, doc.completedAt),
    salesOrders: doc.salesOrders.length > 0 ? doc.salesOrders.join(', ') : null,
    purchaseOrder: doc.purchaseOrder,
    netAmount: doc.netAmount,
    currencyCode: doc.currencyCode,
    email: doc.emailSender,
    location: doc.emailSender,
    region: doc.region,
    bu: doc.businessUnit,
    rejectionReason: doc.cancelReason,
    automationType: null,
    changedFields: null,
    split: null
  };
}

/**
 * Expands a document into one row per line item (position-level detail).
 * Header fields left empty per spec: location, automationType, changedFields, split.
 */
function formatLineRows(doc) {
  if (doc.lineItems.length === 0) return [];
  return doc.lineItems.map(li => ({
    logId: doc.logId,
    position: li.itemNumber,
    status: doc.status,
    createdAt: doc.createdAt,
    completedAt: li.completedAt || doc.completedAt,
    hours: calcHours(doc.createdAt, li.completedAt || doc.completedAt),
    salesOrder: li.SalesOrder || null,
    netAmount: li.netAmount,
    currencyCode: li.currencyCode,
    quantity: li.quantity,
    email: doc.emailSender,
    location: doc.emailSender,
    region: doc.region,
    bu: doc.businessUnit,
    rejectionReason: doc.cancelReason,
    automationType: null,
    changedFields: null,
    split: null
  }));
}

/** Builds the full row array for a detail response (header or line level). */
function buildDetailRows(docs, linesMode) {
  if (!linesMode) return docs.map(formatHeaderRow);
  return docs.flatMap(formatLineRows);
}

// ─── Service handlers ─────────────────────────────────────────────────────────

export default function (srv) {

  /**
   * KPI_Orders_Detail
   * Returns a paginated list of non-PR1 documents within a date range.
   * Supports optional multi-value filters: location, region, bu, automationType.
   * When Lines="X" the response is at position level (one row per line item).
   *
   * POST /kpi/KPI_Orders_Detail
   * Body: {
   *   dateFrom, dateTo,
   *   location?: string[], region?: string[], bu?: string[], automationType?: string[],
   *   Lines?: "X", page?: number, pageSize?: number
   * }
   */
  srv.on('KPI_Orders_Detail', async (req) => {
    try {
      const { dateFrom, dateTo, location, region, bu, automationType, Lines, page, pageSize } = req.data;
      const docs = await fetchDetailDocuments(dateFrom, dateTo, { location, region, bu, automationType });
      const rows = buildDetailRows(docs, Lines === 'X');
      return JSON.stringify(paginate(rows, page, pageSize));
    } catch (err) {
      req.error(400, 'KPI_Orders_Detail error: ' + err.message);
    }
  });

  /**
   * KPI_Orders
   * Returns aggregated order counts (or averages) for chart rendering.
   *
   * kpiId 1 – per CSR inbox location (emailSender)
   * kpiId 2 – per region (emea/latam/na/aspac)
   * kpiId 3 – per business unit (hb/fi/taste/scent)
   *
   * Lines="X"   → counts positions instead of orders
   * Average="X" → returns average processing hours instead of count
   *
   * POST /kpi/KPI_Orders
   * Body: {
   *   dateFrom, dateTo, kpiId,
   *   location?: string[], region?: string[], bu?: string[], automationType?: string[],
   *   Lines?: "X", Average?: "X"
   * }
   */
  srv.on('KPI_Orders', async (req) => {
    try {
      const { dateFrom, dateTo, kpiId, location, region, bu, automationType, Lines, Average } = req.data;

      if (![1, 2, 3].includes(kpiId)) {
        req.error(400, 'kpiId must be 1, 2 or 3');
        return;
      }

      const linesMode = Lines === 'X';
      const docs = await fetchAggregateDocuments(
        dateFrom, dateTo,
        { location, region, bu, automationType },
        linesMode
      );

      if (Average === 'X') {
        const sumMap = {}, countMap = {};
        for (const d of docs) {
          const key = getDimensionKey(d, kpiId);
          const h = calcHours(d.createdAt, d.completedAt);
          if (h !== null) {
            sumMap[key] = (sumMap[key] || 0) + h;
            countMap[key] = (countMap[key] || 0) + 1;
          }
        }
        const result = Object.entries(sumMap)
          .map(([label, sum]) => ({ label, averageHours: parseFloat((sum / countMap[label]).toFixed(2)) }))
          .sort((a, b) => b.averageHours - a.averageHours);
        return JSON.stringify(result);
      }

      const countMap = {};
      for (const d of docs) {
        const key = getDimensionKey(d, kpiId);
        countMap[key] = (countMap[key] || 0) + (linesMode ? (d._lineCount || 0) : 1);
      }
      const result = Object.entries(countMap)
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => b.count - a.count);
      return JSON.stringify(result);
    } catch (err) {
      req.error(400, 'KPI_Orders error: ' + err.message);
    }
  });

  /**
   * KPI_Rejected
   * Returns aggregated rejected-order data grouped by different dimensions.
   *
   * kpiId 1 – rejected count by location per month
   * kpiId 2 – rejected count by region per month
   * kpiId 3 – rejected count by BU per month
   * kpiId 4 – rejected count by rejection reason (cancelReason)
   * kpiId 5 – overall counts split into: approved / automatic (empty) / rejected
   *
   * POST /kpi/KPI_Rejected
   * Body: {
   *   dateFrom, dateTo, kpiId,
   *   location?: string[], region?: string[], bu?: string[]
   * }
   */
  srv.on('KPI_Rejected', async (req) => {
    try {
      const { dateFrom, dateTo, kpiId, location, region, bu } = req.data;

      if (![1, 2, 3, 4, 5].includes(kpiId)) {
        req.error(400, 'kpiId must be 1, 2, 3, 4 or 5');
        return;
      }

      // kpiId 1–3: rejected orders grouped by dimension per month
      if (kpiId <= 3) {
        const docs = await fetchAggregateDocuments(dateFrom, dateTo, { location, region, bu, rejectedOnly: true });
        const map = {};
        for (const d of docs) {
          const month = d.createdAt ? new Date(d.createdAt).toISOString().slice(0, 7) : 'unknown';
          const dim = getDimensionKey(d, kpiId);
          const key = `${month}||${dim}`;
          map[key] = (map[key] || 0) + 1;
        }
        const result = Object.entries(map).map(([key, count]) => {
          const sep = key.indexOf('||');
          return { month: key.slice(0, sep), dimension: key.slice(sep + 2), count };
        }).sort((a, b) => a.month.localeCompare(b.month) || a.dimension.localeCompare(b.dimension));
        return JSON.stringify(result);
      }

      // kpiId 4: rejected orders grouped by rejection reason
      if (kpiId === 4) {
        const docs = await fetchAggregateDocuments(dateFrom, dateTo, { location, region, bu, rejectedOnly: true });
        const map = {};
        for (const d of docs) {
          const reason = d.cancelReason || 'unknown';
          map[reason] = (map[reason] || 0) + 1;
        }
        const result = Object.entries(map)
          .map(([reason, count]) => ({ reason, count }))
          .sort((a, b) => b.count - a.count);
        return JSON.stringify(result);
      }

      // kpiId 5: all orders split into approved / automatic / rejected
      const allDocs = await fetchAggregateDocuments(dateFrom, dateTo, { location, region, bu });
      let approved = 0, rejected = 0;
      for (const d of allDocs) {
        const s = (d.status || '').toLowerCase();
        if (s === REJECTED_STATUS.toLowerCase() || s.includes('reject')) {
          rejected++;
        } else if (s.includes('complet') || s.includes('approv')) {
          approved++;
        }
      }
      return JSON.stringify([
        { label: 'approved', count: approved },
        { label: 'automatic', count: 0 },
        { label: 'rejected', count: rejected }
      ]);
    } catch (err) {
      req.error(400, 'KPI_Rejected error: ' + err.message);
    }
  });

  /**
   * KPI_Rejected_Detail
   * Returns a paginated list of rejected orders with the same columns as
   * KPI_Orders_Detail, filtered by the supplied parameters.
   *
   * POST /kpi/KPI_Rejected_Detail
   * Body: {
   *   dateFrom, dateTo,
   *   location?: string[], region?: string[], bu?: string[],
   *   reason?: string[], automationType?: string[],
   *   Lines?: "X", page?: number, pageSize?: number
   * }
   */
  /**
   * KPI_Rate
   * Returns the order count per month for the given region, further filtered
   * by location (array), bu (array) and automationType (array).
   *
   * POST /kpi/KPI_Rate
   * Body: {
   *   dateFrom, dateTo,
   *   region: string,
   *   location?: string[], bu?: string[], automationType?: string[]
   * }
   * Response: [{ month: "YYYY-MM", region: string, count: number }, ...]
   */
  srv.on('KPI_Rate', async (req) => {
    try {
      const { dateFrom, dateTo, region, location, bu, automationType } = req.data;

      if (!region) {
        req.error(400, 'region is required for KPI_Rate');
        return;
      }

      // Reuse fetchAggregateDocuments with a single-value region filter
      const docs = await fetchAggregateDocuments(dateFrom, dateTo, {
        location,
        region: [region],
        bu,
        automationType
      });

      const map = {};
      for (const d of docs) {
        const month = d.createdAt ? new Date(d.createdAt).toISOString().slice(0, 7) : 'unknown';
        map[month] = (map[month] || 0) + 1;
      }

      const result = Object.entries(map)
        .map(([month, count]) => ({ month, region, count }))
        .sort((a, b) => a.month.localeCompare(b.month));

      return JSON.stringify(result);
    } catch (err) {
      req.error(400, 'KPI_Rate error: ' + err.message);
    }
  });

  srv.on('KPI_Rejected_Detail', async (req) => {
    try {
      const { dateFrom, dateTo, location, region, bu, reason, automationType, Lines, page, pageSize } = req.data;
      const docs = await fetchDetailDocuments(dateFrom, dateTo, {
        location, region, bu, automationType, reason, rejectedOnly: true
      });
      const rows = buildDetailRows(docs, Lines === 'X');
      return JSON.stringify(paginate(rows, page, pageSize));
    } catch (err) {
      req.error(400, 'KPI_Rejected_Detail error: ' + err.message);
    }
  });
}
