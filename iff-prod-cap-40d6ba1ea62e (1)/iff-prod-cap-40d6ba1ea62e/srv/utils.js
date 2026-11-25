import cds from '@sap/cds';
import { executeHttpRequest } from '@sap-cloud-sdk/http-client';
import { lookup as lookupMime } from 'mime-types';

const { SELECT, INSERT, UPDATE, DELETE } = cds.ql;

const MAX_PARTNER_OPTIONS = 10;

export const FIELD_TRACKING_TARGETS = {
  Documents: [
    "status",
  ],
  DocumentHeaders: [
    "deliveryDate",
    "documentNumber",
    "documentDate",
    "customerRefDate",
    "paymentTerms",
    "netAmount",
    "sentDate",
    "dtmSalesOrg",
    "dtmOrderType",
    "dtmDivision",
    "salesGroup",
    "priceGroup",
    "senderId",
    "senderName",
    "senderAddress"
  ],
  DocumentLineItems: [
    "customerMaterialNumber",
    "description",
    "quantity",
    "documentDate",
    "itemNumber",
    "unitOfMeasure",
    "netAmount",
    "unitPrice",
    "SAPUnitOfMeasure",
    "SAPQuantity",
    "SAPMaterialNo",
    "SAPMaterialDescription",
    "SAPCustMatNum",
    "SAPCustMatDesc",
    "shippingType",
    "GIDate",
    "LoadDate",
    "MSDate",
    "TPDate",
    "ItemCategory",
    "Plant",
    "Route",
    "documentNumber",
    "currencyCode",
    "ConfDelDate",
    "CondGrp1",
    "SalesOrder",
    "orderCreatedBy",
  ],
  DocumentHeaderStats: [
    "shipToName",
    "shipToId",
    "shipToAddress",
    "soldToName",
    "soldToId",
    "soldToAddress",
    "payerId",
    "payerName",
    "payerAddress",
    "SAPCurrencyCode",
    "billToId",
    "billToName",
    "billToAddress",
    "incoTerm1",
    "incoTerm1Desc",
    "incoTerm2",
    "incoTerm2Desc"
  ],
  DocumentPrices: [
    "CondValue",
    "Currency",
    "CondUnit",
    "CondPricingUnit",
    "CondPriceDate",
  ],
  DocumentPartners: [
    "APCode",
    "APName",
    "ZDCode",
    "ZDName",
    "ZFCode",
    "ZFName",
    "ZQCode",
    "ZQName",
    "ZRCode",
    "ZRName",
    "ZSCode",
    "ZSName",
  ],
  DocumentTexts: [
    "text",
    "lang",
  ],
};

// Mapping of decimal formats returned by CountryFormats service
export const DECIMAL_FORMAT_MAPPINGS = {
  "": { pattern: "1.234.567,89", thousandSeparator: ".", decimalSeparator: "," },
  X: { pattern: "1,234,567.89", thousandSeparator: ",", decimalSeparator: "." },
  Y: { pattern: "1 234 567,89", thousandSeparator: " ", decimalSeparator: "," },
};

// Mapping of date formats returned by CountryFormats service
export const DATE_FORMAT_MAPPINGS = {
  1: { pattern: "DD.MM.YYYY" },
  2: { pattern: "MM/DD/YYYY" },
  3: { pattern: "MM-DD-YYYY" },
  4: { pattern: "YYYY.MM.DD" },
  5: { pattern: "YYYY/MM/DD" },
  6: { pattern: "YYYY-MM-DD" },
  7: { pattern: "GYY.MM.DD" },
  8: { pattern: "GYY/MM/DD" },
  9: { pattern: "GYY-MM-DD" },
  A: { pattern: "GY.MM.DD" },
  B: { pattern: "GY/MM/DD" },
  C: { pattern: "GY-MM-DD" },
};

// Default date format when CountryFormats does not provide one
export const DEFAULT_DATE_FORMAT = { pattern: "DD/MM/YYYY" };

export async function deriveSystemAndCustomer(emailSender, emailFrom) {
  const db = await cds.connect.to('db');
  const { EmailMapping, CustomerConfig } = cds.entities('soautomation');

  const normalizedEmailSender = (emailSender || "").toLowerCase();
  let system = null;

  if (normalizedEmailSender) {
    const mapping = await db.run(
      SELECT.one.from(EmailMapping)
        .where`lower(email) = ${normalizedEmailSender}`
    );

    if (mapping?.system) {
      console.log("System for emailSender:", normalizedEmailSender, "is:", mapping.system)
      system = mapping.system;
    }
  }

  const domain = extractEmailDomain(emailFrom);
  let customer = null;

  if (domain) {
    const config = await db.run(
      SELECT.one.from(CustomerConfig).where({ customer: domain })
    );

    if (config?.customer) {
      customer = config.customer;
    }
  }

  return { system, customer, domain };
}

export const SPLIT_BY_SALES_ORG_LOGIC = "SPLIT_BY_SALES_ORG";

export function extractSalesOrgFromLineItem(lineItem) {
  const salesOrgEntry = ensureArray(lineItem).find(
    (field) => field?.name === "salesOrg"
  );
  const salesOrgValue = salesOrgEntry?.value;
  if (salesOrgValue === null || salesOrgValue === undefined) return null;
  const normalized = String(salesOrgValue).trim();
  return normalized || null;
}

export function groupLineItemsBySalesOrg(lineItems) {
  const groups = new Map();
  let hasValidSalesOrg = false;

  for (const lineItem of ensureArray(lineItems)) {
    const salesOrg = extractSalesOrgFromLineItem(lineItem);
    if (salesOrg) hasValidSalesOrg = true;
    const groupKey = salesOrg || "UNKNOWN";
    const existing = groups.get(groupKey);
    if (existing) {
      existing.items.push(lineItem);
    } else {
      groups.set(groupKey, { salesOrg, items: [lineItem] });
    }
  }

  const groupedValues = Array.from(groups.values());
  const filteredGroups = hasValidSalesOrg
    ? groupedValues.filter((group) => group?.salesOrg)
    : groupedValues;

  return {
    hasValidSalesOrg,
    groups: filteredGroups,
  };
}

export function setHeaderSalesOrg(payload, salesOrg) {
  if (!payload.extraction || typeof payload.extraction !== "object") return;
  const headerFields = ensureArray(payload.extraction.headerFields);
  const targetValue = salesOrg ?? "";
  let found = false;

  for (const field of headerFields) {
    if (field?.name === "dtmSalesOrg") {
      field.value = targetValue;
      found = true;
      break;
    }
  }

  if (!found) {
    headerFields.push({ name: "dtmSalesOrg", value: targetValue });
  }

  payload.extraction.headerFields = headerFields;
}

export async function resolveSplitLogicForRequest(customer, ruleId) {
  const normalizedCustomer = String(customer || "").trim();
  const normalizedRuleId = String(ruleId || "").trim();
  if (!normalizedCustomer || !normalizedRuleId) return null;

  const db = await cds.connect.to("db");
  const { CustomerConfig, CustomerConfigRule } = cds.entities("soautomation");

  const customerConfig = await db.run(
    SELECT.one.from(CustomerConfig).where({ customer: normalizedCustomer })
  );
  if (!customerConfig) return null;

  const rule = await db.run(
    SELECT.one
      .from(CustomerConfigRule)
      .where({ ID: normalizedRuleId, customer_customer: normalizedCustomer })
      .columns("logic")
  );

  const logic = rule?.logic;
  if (logic === null || logic === undefined) return null;
  const normalizedLogic = String(logic);
  return normalizedLogic.trim() ? normalizedLogic : null;
}

export async function splitDocumentBySalesOrg({
  srv,
  basePayload,
  groupedLineItems,
  reuseFirstDocument = false,
}) {
  const logsId = [];
  let parentLogId = null;

  for (let index = 0; index < groupedLineItems.length; index += 1) {
    const group = groupedLineItems[index];
    const splitPayload = JSON.parse(JSON.stringify(basePayload));
    splitPayload.extraction = splitPayload.extraction || {};
    splitPayload.extraction.lineItems = ensureArray(group?.items);
    setHeaderSalesOrg(splitPayload, group?.salesOrg || null);
    splitPayload.splitIsParent = index === 0;
    splitPayload.splitParentLogId = index === 0 ? null : parentLogId;
    splitPayload.forceInsert = !(reuseFirstDocument && index === 0);

    const upsertResult = await srv.send("upsertDocument", {
      body: JSON.stringify(splitPayload),
    });
    const currentLogId = upsertResult?.logId;
    if (currentLogId !== null && currentLogId !== undefined) {
      logsId.push(currentLogId);
      if (index === 0) {
        parentLogId = currentLogId;
      }
    }
  }

  return logsId;
}

function extractEmailDomain(emailFrom) {
  if (!emailFrom) return null;

  const raw = String(emailFrom).toLowerCase();

  const match = raw.match(/@[^\s,;>]+/);
  if (match && match[0]) {
    return match[0];
  }

  const atIndex = raw.indexOf("@");
  return atIndex !== -1 ? raw.slice(atIndex) : null;
}

export function extractDomains(html) {
  if (!html) return [];

  const content = String(html).toLowerCase();
  const regex = /[a-z0-9._%+-]+@([a-z0-9.-]+\.[a-z]{2,})/gi;
  const found = new Set();
  let match;

  while ((match = regex.exec(content)) !== null) {
    const domainPart = (match[1] || "").trim();
    if (!domainPart || domainPart.includes("iff")) continue;
    found.add(`@${domainPart}`);
  }

  return [...found];
}


export function isTimeoutError(error) {
  const timeoutCodes = new Set(["ETIMEDOUT", "ECONNABORTED"]);
  const text = [
    error?.message,
    error?.cause?.message,
    error?.rootCause?.message,
    error?.response?.data?.error?.message,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return timeoutCodes.has(error?.code)
    || timeoutCodes.has(error?.cause?.code)
    || text.includes("timeout")
    || text.includes("timed out");
}
export function parseExtractedJSON(raw) {
  if (!raw || typeof raw !== "string") {
    throw new Error("Missing or invalid JSON string");
  }

  raw = raw.trim();

  if (raw.startsWith('"') && raw.endsWith('"')) {
    raw = raw.slice(1, -1);
  }

  let parsed = null;
  for (let i = 0; i < 3; i++) {
    try {
      parsed = JSON.parse(raw);
      break;
    } catch (err) {
      raw = raw
        .replace(/\\\\\"/g, '"')
        .replace(/\\\\"/g, '"')
        .replace(/\\\\/g, "\\");
      raw = raw.replace(/\\"/g, '"');
    }
  }

  if (!parsed) throw new Error("Invalid JSON structure after unescaping");

  return parsed;
}

export function normalizeLabel(label = "") {
  if (!label || typeof label !== "string") return "";
  return label
    .trim()
    .replace(/[-_ ]+(\w)/g, (_, c) => c.toUpperCase())
    .replace(/^./, (c) => c.toLowerCase());
}

export function truncateRecordStringsByEntity(record = {}, entity) {
  if (!record || typeof record !== "object" || !entity?.elements) {
    return record;
  }

  for (const [fieldName, fieldValue] of Object.entries(record)) {
    if (typeof fieldValue !== "string") continue;

    const maxLength = Number(entity.elements?.[fieldName]?.length);
    if (!Number.isInteger(maxLength) || maxLength <= 0) continue;

    if (fieldValue.length > maxLength) {
      record[fieldName] = fieldValue.slice(0, maxLength);
    }
  }

  return record;
}

const REQUIRED_ECC_HEADER_FIELDS = {
  TaxId: "",
  Internal: "",
  Quantity: "",
  SenderId: "",
  ShipToId: "",
  NetAmount: "",
  SenderFax: "",
  ShipToFax: "",
  ReceiverId: "",
  SenderCity: "",
  SenderName: "",
  ShipToCity: "",
  ShipToName: "",
  GrossAmount: "",
  SenderEmail: "",
  SenderPhone: "",
  SenderState: "",
  ShipToEmail: "",
  ShipToPhone: "",
  ShipToState: "",
  TaxIdNumber: "",
  CurrencyCode: "",
  DeliveryDate: "",
  DocumentDate: "",
  PaymentTerms: "",
  SenderStreet: "",
  ShipToStreet: "",
  PurchaseOrder: "",
  SenderAddress: "",
  ShipToAddress: "",
  ShippingTerms: "",
  SenderDistrict: "",
  ShipToDistrict: "",
  SenderPostalCode: "",
  ShipToPostalCode: "",
  SenderBankAccount: "",
  SenderCountryCode: "",
  SenderHouseNumber: "",
  ShipToCountryCode: "",
  ShipToHouseNumber: "",
  SenderExtAddressPart: "", // ✅ corregido el nombre
};

export function mapDoxToECC(raw) {
  const data = parseExtractedJSON(raw);
  if (!data.extraction)
    throw new Error("Missing 'extraction' object in DOX payload");

  const extraction = data.extraction;
  const headerObj = {};
  const headerFields = extraction.headerFields || [];

  const excludedFields = [
    "addfielditem1",
    "addfielditem2",
    "addfielditem3"
  ];

  for (const field of headerFields) {
    let key = normalizeLabel(field._name || field.name);
    const value = field.value ?? field.text ?? "";

    const normalizedKey = key.toLowerCase();
    if (excludedFields.includes(normalizedKey)) {
      continue;
    }

    if (key === "SenderExtraAddresPart" || key === "SenderExtraAddressPart") {
      key = "SenderExtAddressPart";
    }

    if (key) headerObj[toTitleCase(key)] = value;
  }

  if (headerObj.DocumentNumber) {
    headerObj.PurchaseOrder = headerObj.DocumentNumber;
    delete headerObj.DocumentNumber;
  }

  const lineItemsRaw = extraction.lineItems || [];
  const lineItems = [];

  for (let index = 0; index < lineItemsRaw.length; index++) {
    const group = lineItemsRaw[index];
    const itemObj = {};

    for (const f of group) {
      const key = normalizeLabel(f.name || f._name);
      if (!key) continue;
      const normalizedKey = key.toLowerCase();

      // Si la key está en la lista de exclusión → no se guarda
      if (excludedFields.includes(normalizedKey)) {
        continue;
      }

      const rawValue = f.value ?? f.text ?? "";
      let value = rawValue;

      if (key === "quantity") {
        const sanitizedQuantity = sanitizeQuantityValue(rawValue);
        value =
          sanitizedQuantity !== null && sanitizedQuantity !== undefined
            ? String(sanitizedQuantity)
            : rawValue !== undefined && rawValue !== null
              ? String(rawValue)
              : "";
      }

      if (key !== "itemNumber") {
        itemObj[toTitleCase(key)] = value;
      }
    }

    const sequentialItemNumber = (index + 1) * 10;
    itemObj["ItemNumber"] = String(sequentialItemNumber);

    const requiredItemFields = [
      "Quantity",
      "NetAmount",
      "UnitPrice",
      "ItemNumber",
      "Description",
      "CurrencyCode",
      "DocumentDate",
      "UnitOfMeasure",
      "CustomerMatNum",
      "DocumentNumber",
      "SupplierMatNum",
    ];

    for (const field of requiredItemFields) {
      if (!itemObj[field]) itemObj[field] = "";
    }

    lineItems.push(itemObj);
  }

  const eccHeader = { ...REQUIRED_ECC_HEADER_FIELDS, ...headerObj };

  if (!eccHeader.SenderExtAddressPart) {
    if (eccHeader.SenderExtraAddressPart) {
      eccHeader.SenderExtAddressPart = eccHeader.SenderExtraAddressPart;
    } else if (eccHeader.SenderExtraAddresPart) {
      eccHeader.SenderExtAddressPart = eccHeader.SenderExtraAddresPart;
    }
  }

  delete eccHeader.SenderExtraAddressPart;
  delete eccHeader.SenderExtraAddresPart;
  delete eccHeader.SenderExtAddresPart;

  const eccObject = {
    ...eccHeader,
    Nav_ShipTo: [{}],
    Nav_SoldTo: [{}],
    Nav_ItemStat: [{}],
    Nav_HeaderStat: [{}],
    Nav_LineItem: lineItems,
  };

  return eccObject;
}

function toTitleCase(str = "") {
  if (!str) return "";
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function parseItemNumber(rawNumber) {
  if (rawNumber === undefined || rawNumber === null) return null;
  const cleaned = String(rawNumber).trim();
  if (!cleaned) return null;
  const parsed = parseInt(cleaned.replace(/^0+/, ""), 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function parseDecimal(rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === "")
    return null;
  const num = Number(rawValue);
  return Number.isFinite(num) ? num : null;
}

function normalizeDateString(value) {
  if (value === undefined || value === null) return null;

  const str = String(value).trim();
  if (!str) return null;

  const datePartsMatch = /^([0-9]{4})[-/]([0-9]{2})[-/]([0-9]{2})$/.exec(str);
  if (datePartsMatch) {
    const [, yearStr, part2Str, part3Str] = datePartsMatch;
    const year = Number(yearStr);
    let month = Number(part2Str);
    let day = Number(part3Str);

    if (Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(day)) {
      return null;
    }

    if (month > 12 && day <= 12) {
      [month, day] = [day, month];
    }

    if (month < 1 || month > 12 || day < 1 || day > 31) {
      return null;
    }

    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (
      Number.isNaN(parsed.getTime()) ||
      parsed.getUTCFullYear() !== year ||
      parsed.getUTCMonth() + 1 !== month ||
      parsed.getUTCDate() !== day
    ) {
      return null;
    }

    return parsed.toISOString().slice(0, 10);
  }

  const parsed = new Date(str);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString().slice(0, 10);
}

export async function persistODataDetermineResult(result, context = {}, req) {
  if (!result) {
    return;
  }

  const userEmail =
    req?.user?.attr?.email ??
    context?.userEmail ??
    null;

  let payload = result;
  if (typeof result === "string") {
    try {
      payload = JSON.parse(result);
    } catch (err) {
      // If parsing fails, skip persistence to avoid crashing the action
      return;
    }
  }

  if (!payload || typeof payload !== "object") {
    return;
  }

  const entities = cds.entities("soautomation");
  if (!entities) {
    return;
  }

  const {
    Documents,
    DocumentHeaders,
    DocumentLineItems,
    DocumentSoldToOptions,
    DocumentShipToOptions,
    DocumentMaterialOptions,
    DocumentHeaderStats,
    DocumentSalesOrgs,
    DocumentErrorLogs,
    DocumentFieldHistories,
  } = entities;

  const tx = cds.transaction(req) || (await cds.connect.to("db"));

  const attachmentId =
    context.attachmentId ||
    context.attachmentid ||
    context.AttachmentId ||
    context.AttachmentID;
  const instanceId =
    context.instanceId ||
    context.instanceid ||
    context.instanceID ||
    context.InstanceId ||
    context.InstanceID;
  const normalizedLogId = normalizeOptionalLogId(
    context.logId ??
    context.LogId ??
    context.logID ??
    context.LogID
  );

  let documentId =
    context.documentId ||
    context.documentID ||
    context.DocumentId ||
    context.DocumentID ||
    context.ID ||
    null;

  if (attachmentId && !documentId) {
    const documentWhere = normalizedLogId === null
      ? (instanceId ? { attachmentId, instanceId } : { attachmentId })
      : (instanceId
        ? { attachmentId, instanceId, LogId: normalizedLogId }
        : { attachmentId, LogId: normalizedLogId });

    const existingDocument = await tx.run(
      SELECT.one.from(Documents).columns("ID").where(documentWhere)
    );
    if (existingDocument) {
      documentId = existingDocument.ID;
    }
  }

  const purchaseOrder = payload.PurchaseOrder || payload.SalesOrderNum;
  if (!documentId && purchaseOrder) {
    const existingHeader = await tx.run(
      SELECT.one
        .from(DocumentHeaders)
        .columns("documentID_ID")
        .where({ documentNumber: purchaseOrder })
    );
    if (existingHeader) {
      documentId = existingHeader.documentID_ID;
    }
  }

  if (!documentId) {
    return;
  }

  const documentSystem = toStringSafe(
    context.documentSystem ??
    context.system ??
    payload.documentSystem ??
    payload.DocumentSystem ??
    payload.System ??
    payload.system ??
    ""
  )
    .trim()
    .toUpperCase();
  const isPr1 = documentSystem === "PR1";
  const logSource = isPr1
    ? toStringSafe(context.logSource || "VALIDATE").trim().toUpperCase() || "VALIDATE"
    : null;
  const pr1Payload = isPr1 ? payload.result ?? payload.Result ?? payload : null;
  const trainingValue =
    payload.Training ??
    payload.training ??
    payload.Result?.Training ??
    payload.result?.Training ??
    payload.d?.Training ??
    payload.d?.training;

  const documentUpdates = {};

  if (trainingValue !== undefined) {
    documentUpdates.training = trainingValue === null ? null : toStringSafe(trainingValue);
  }

  if (isPr1) {
    const resolvedTaskId =
      pr1Payload?.TaskID ??
      pr1Payload?.TaskId ??
      pr1Payload?.taskID ??
      pr1Payload?.taskId ??
      payload?.TaskID ??
      payload?.TaskId ??
      payload?.taskID ??
      payload?.taskId;

    const resolvedTaskStatus =
      pr1Payload?.TaskStatus ??
      pr1Payload?.taskStatus ??
      payload?.TaskStatus ??
      payload?.taskStatus;

    documentUpdates.taskId = toStringSafe(resolvedTaskId);
    documentUpdates.taskStatus = toStringSafe(resolvedTaskStatus);
  }

  if (Object.keys(documentUpdates).length > 0) {
    await tx.run(
      UPDATE(Documents)
        .set(documentUpdates)
        .where({ ID: documentId })
    );
  }
  const returnEntries = toArray(payload.Nav_Return)
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }

      const rawType = entry.Type ?? entry.type ?? "";
      const normalizedType = toStringSafe(rawType).trim().toUpperCase();
      const finalType = normalizedType === "I" ? "W" : normalizedType;

      const message = toStringSafe(entry.Message ?? entry.message ?? "").trim();
      const rawNumber = toStringSafe(entry.Number ?? entry.number ?? "").trim();
      const rawId = toStringSafe(entry.Id ?? entry.ID ?? entry.id ?? "").trim();

      if (!finalType && !message && !rawNumber) {
        return null;
      }

      const number = isPr1
        ? (rawNumber || null)
        : `${rawId} - ${rawNumber} `;

      return {
        ID: cds.utils.uuid(),
        documentID_ID: documentId,
        type: finalType,
        message: message || null,
        number,
        source: logSource,
      };
    })
    .filter((entry) => !!entry);

  if (DocumentErrorLogs) {
    await tx.run(
      DELETE.from(DocumentErrorLogs).where({ documentID_ID: documentId })
    );

    if (returnEntries.length > 0) {
      await tx.run(INSERT.into(DocumentErrorLogs).entries(returnEntries));
    }
  }

  const headerStatsArray = toArray(payload.Nav_HeaderStat);
  const headerStatEntry = headerStatsArray[0] || {};
  const getFirstNonEmptyHeaderStatValue = (keys = [], startIndex = 0, fallbackAcrossEntries = true) => {
    const start = fallbackAcrossEntries ? startIndex : 0;
    const end = fallbackAcrossEntries ? headerStatsArray.length : Math.min(1, headerStatsArray.length);

    for (let index = start; index < end; index += 1) {
      const entry = fallbackAcrossEntries ? headerStatsArray[index] : headerStatEntry;
      if (!entry || typeof entry !== "object") continue;
      for (const key of keys) {
        const value = entry?.[key];
        if (value === null || value === undefined) continue;
        if (typeof value === "string" && value.trim() === "") continue;
        return value;
      }
    }
    return "";
  };

  const orderTypeValue =
    getFirstNonEmptyHeaderStatValue([
      "OrderType",
      "orderType",
      "Order Type",
    ], 0, isPr1) ||
    payload?.DocumentType ||
    payload?.documentType ||
    "";
  const salesOrgValue = getFirstNonEmptyHeaderStatValue([
    "SalesOrg",
    "Sales Org",
    "salesOrg",
  ], 0, isPr1);
  const divisionValue = getFirstNonEmptyHeaderStatValue([
    "Division",
    "division",
  ], 0, isPr1);

  const resolvePr1PartnerEntry = ({ rootValues, navArray, navKeyAliases }) => {
    const rootResolved = {
      id: toStringSafe(rootValues.id ?? "").trim(),
      name: toStringSafe(rootValues.name ?? "").trim(),
      address: toStringSafe(rootValues.address ?? "").trim(),
    };

    if (rootResolved.id || rootResolved.name || rootResolved.address) {
      return rootResolved;
    }

    for (const entry of toArray(navArray)) {
      if (!entry || typeof entry !== "object") continue;

      const pickFromEntry = (aliases) => {
        for (const key of aliases) {
          const value = entry[key];
          if (value === null || value === undefined) continue;
          const trimmed = toStringSafe(value).trim();
          if (trimmed !== "") return trimmed;
        }
        return "";
      };

      const candidate = {
        id: pickFromEntry(navKeyAliases.id),
        name: pickFromEntry(navKeyAliases.name),
        address: pickFromEntry(navKeyAliases.address),
      };

      if (candidate.id || candidate.name || candidate.address) {
        return candidate;
      }
    }

    return { id: "", name: "", address: "" };
  };

  const payerEntry = isPr1
    ? resolvePr1PartnerEntry({
        rootValues: {
          id: payload?.PayerId,
          name: payload?.Payer_name ?? payload?.PayerName ?? payload?.payerName,
          address: payload?.PayerAddress ?? payload?.payerAddress,
        },
        navArray: payload?.Nav_Payer,
        navKeyAliases: {
          id: ["PayerId", "payerId"],
          name: ["PayerName", "payerName", "Payer_name"],
          address: ["PayerAddress", "payerAddress"],
        },
      })
    : { id: "", name: "", address: "" };
  const billToEntry = isPr1
    ? resolvePr1PartnerEntry({
        rootValues: {
          id: payload?.BillToId,
          name: payload?.BillTo_Name ?? payload?.BillToName ?? payload?.billToName,
          address: payload?.BillToAddress ?? payload?.billToAddress,
        },
        navArray: payload?.Nav_BillTo,
        navKeyAliases: {
          id: ["BillToId", "billToId"],
          name: ["BillToName", "billToName", "BillTo_Name"],
          address: ["BillToAddress", "billToAddress"],
        },
      })
    : { id: "", name: "", address: "" };
  const payerId = isPr1 ? payerEntry.id || null : null;
  const payerName = isPr1 ? payerEntry.name || null : null;
  const payerAddress = isPr1 ? payerEntry.address || null : null;
  const billToId = isPr1 ? billToEntry.id || null : null;
  const billToName = isPr1 ? billToEntry.name || null : null;
  const billToAddress = isPr1 ? billToEntry.address || null : null;

  const headerUpdates = {
    dtmOrderType: orderTypeValue ?? "",
    dtmSalesOrg: salesOrgValue ?? "",
  };

  if (!isPr1) {
    // Begin fix - Use PODate from validation payload response as PO Date - Blueboot 17/02/2026
    const poDateFromHeaderStat = normalizeDateString(
      getFirstNonEmptyHeaderStatValue(["PODate", "poDate"], 0, isPr1) || null
    );
  
    if (poDateFromHeaderStat) {
      headerUpdates.documentDate = poDateFromHeaderStat;
      headerUpdates.sentDate = poDateFromHeaderStat;
    }
    // End fix - Blueboot 17/02/2026

    // Begin fix - Sender country code updated from validation response - Blueboot 17/02/2026
    const senderCountryCodeFromHeader = getFirstNonEmptyHeaderStatValue([
      "SenderCountryCode",
      "senderCountryCode",
    ], 0, isPr1);
    if (senderCountryCodeFromHeader || payload?.SenderCountryCode) {
      headerUpdates.extractedSenderCountryCode =
        senderCountryCodeFromHeader || payload.SenderCountryCode;
    }
    // End fix - Blueboot 17/02/2026
  }

  if (isPr1 && pr1Payload) {
    headerUpdates.dtmDivision = toStringSafe(divisionValue).trim() || null;

    const salesGroup = toStringSafe(
      pr1Payload.SalesGroup ?? pr1Payload.salesGroup ?? ""
    ).trim();
    const salesGroupDescription = toStringSafe(
      pr1Payload.SalesGroupDescription ??
      pr1Payload.salesGroupDescription ??
      ""
    ).trim();
    const priceGroup = toStringSafe(
      pr1Payload.PriceGroup ?? pr1Payload.priceGroup ?? ""
    ).trim();
    const priceGroupDescription = toStringSafe(
      pr1Payload.PriceGroupDescription ??
      pr1Payload.priceGroupDescription ??
      ""
    ).trim();

    headerUpdates.salesGroup = salesGroup || null;
    headerUpdates.salesGroupDescription = salesGroupDescription || null;
    headerUpdates.priceGroup = priceGroup || null;
    headerUpdates.priceGroupDescription = priceGroupDescription || null;
  }

  const existingHeaderForTracking = DocumentFieldHistories
    ? await tx.run(
        SELECT.one
          .from(DocumentHeaders)
          .where({ documentID_ID: documentId })
      )
    : null;

  await tx.run(
    UPDATE(DocumentHeaders).set(headerUpdates).where({ documentID_ID: documentId })
  );

  if (existingHeaderForTracking && DocumentFieldHistories) {
    await trackFieldChanges(tx, DocumentFieldHistories, {
      documentId,
      entityName: "DocumentHeaders",
      recordId: existingHeaderForTracking.ID,
      existingRecord: existingHeaderForTracking,
      updateData: headerUpdates,
      trackedFields: FIELD_TRACKING_TARGETS.DocumentHeaders || [],
      userEmail,
    });
  }

  const buildHeaderStatValue = (keys) => {
    const value = getFirstNonEmptyHeaderStatValue(keys, 0, isPr1);
    return value === "" ? null : value;
  };

  const purchaseOrderNumber = buildHeaderStatValue([
    "PurchaseNo",
    "PurchaseOrder",
    "Purchase",
    "PONumber",
    "poNumber",
    "purchaseNo",
    "purchaseOrder",
    "purchase",
  ]);

  const purchaseOrderDateRaw = buildHeaderStatValue([
    "PODate",
    "PurchaseOrderDate",
    "purchaseOrderDate",
    "poDate",
  ]);

  const purchaseOrderDate = normalizeDateString(purchaseOrderDateRaw);

  const orderType = buildHeaderStatValue(["OrderType", "orderType", "Order Type"]);
  const salesOrg = buildHeaderStatValue(["SalesOrg", "Sales Org", "salesOrg"]);
  const shipToName = buildHeaderStatValue(["ShipToName", "shipToName"]);
  const shipToAddressFromHeaderStat = buildHeaderStatValue([
    "ShipToAddress",
    "shipToAddress",
  ]);
  const soldToAddressFromHeaderStat = buildHeaderStatValue([
    "SoldToAddress",
    "soldToAddress",
  ]);
  const shipToAddress =
    shipToAddressFromHeaderStat ||
    (isPr1
      ? payload?.ShipToAddress ?? payload?.shipToAddress ?? null
      : null);
  const soldToAddress =
    soldToAddressFromHeaderStat ||
    (isPr1
      ? payload?.SoldToAddress ?? payload?.soldToAddress ?? null
      : null);
  const soldToName = buildHeaderStatValue(["SoldToName", "soldToName"]);
  const shipToId = buildHeaderStatValue([
    "ShipTo",
    "shipTo",
    "ShipToId",
    "shipToId",
  ]);
  const soldToId = buildHeaderStatValue([
    "SoldTo",
    "soldTo",
    "SoldToId",
    "soldToId",
  ]);
  const incoTerm1 = buildHeaderStatValue(["IncoTerm1", "incoTerm1"]);
  const incoTerm1Desc = buildHeaderStatValue([
    "IncoTerm1Desc",
    "incoTerm1Desc",
    "IncoTerm1Description",
  ]);
  const incoTerm2 = buildHeaderStatValue(["IncoTerm2", "incoTerm2"]);
  const incoTerm2Desc = buildHeaderStatValue([
    "IncoTerm2Desc",
    "incoTerm2Desc",
    "IncoTerm2Description",
  ]);

  const hasMeaningfulValue = [
    purchaseOrderNumber,
    purchaseOrderDate,
    orderType,
    salesOrg,
    shipToName,
    shipToAddress,
    soldToAddress,
    soldToName,
    shipToId,
    soldToId,
    incoTerm1,
    incoTerm1Desc,
    incoTerm2,
    incoTerm2Desc,
    ...(isPr1
      ? [payerId, payerName, payerAddress, billToId, billToName, billToAddress]
      : []),
  ].some((value) => value !== null && value !== "");

  let headerStatsEntry = hasMeaningfulValue
    ? {
        ID: cds.utils.uuid(),
        documentID_ID: documentId,
        purchaseOrderNumber: purchaseOrderNumber || null,
        purchaseOrderDate: purchaseOrderDate || null,
        orderType: orderType || null,
        salesOrg: salesOrg || null,
        shipToName: shipToName || null,
        shipToAddress: shipToAddress || null,
        soldToAddress: soldToAddress || null,
        shipToId: shipToId || null,
        soldToName: soldToName || null,
        soldToId: soldToId || null,
        payerId,
        payerName,
        payerAddress,
        billToId,
        billToName,
        billToAddress,
        incoTerm1: incoTerm1 || null,
        incoTerm1Desc: incoTerm1Desc || null,
        incoTerm2: incoTerm2 || null,
        incoTerm2Desc: incoTerm2Desc || null,
      }
    : null;

  if (
    isPr1 &&
    !headerStatsEntry &&
    [payerId, payerName, payerAddress, billToId, billToName, billToAddress].some(
      (value) => value !== null && value !== ""
    )
  ) {
    headerStatsEntry = {
      ID: cds.utils.uuid(),
      documentID_ID: documentId,
      payerId,
      payerName,
      payerAddress,
      billToId,
      billToName,
      billToAddress,
    };
  }

  // Fields on DocumentHeaderStats that this function owns. When the OData
  // response does not provide meaningful values these are reset to null so the
  // user never sees stale values from a previous request. Other columns
  // (e.g. SAPNetVal, SAPCurrencyCode, TermsOfPayment*) are written by
  // updateDocument and are deliberately left untouched.
  const headerStatsManagedFields = [
    "purchaseOrderNumber",
    "purchaseOrderDate",
    "orderType",
    "salesOrg",
    "shipToName",
    "shipToAddress",
    "soldToAddress",
    "shipToId",
    "soldToName",
    "soldToId",
    "payerId",
    "payerName",
    "payerAddress",
    "billToId",
    "billToName",
    "billToAddress",
    "incoTerm1",
    "incoTerm1Desc",
    "incoTerm2",
    "incoTerm2Desc",
  ];

  const headerStatsUpdatePayload = headerStatsManagedFields.reduce((acc, field) => {
    acc[field] = headerStatsEntry
      ? (headerStatsEntry[field] ?? null)
      : null;
    return acc;
  }, {});

  const existingHeaderStats = DocumentHeaderStats
    ? await tx.run(
        SELECT.from(DocumentHeaderStats)
          .where({ documentID_ID: documentId })
      )
    : [];

  if (existingHeaderStats.length > 0) {
    // Upsert in place: keep the first row as the survivor, drop any
    // duplicates left over by legacy DELETE+INSERT runs.
    const survivor = existingHeaderStats[0];
    const survivorId = survivor.ID;
    const obsoleteIds = existingHeaderStats.slice(1)
      .map((row) => row?.ID)
      .filter((id) => id !== null && id !== undefined && id !== "");

    // Re-point every DocumentHeaderStats history row for this document to
    // the survivor ID. This also self-heals legacy rows whose
    // sourceRecordId still points to a UUID that was deleted in a previous
    // run, so trackFieldChanges below can find and update them.
    if (DocumentFieldHistories) {
      await tx.run(
        UPDATE(DocumentFieldHistories)
          .set({ sourceRecordId: String(survivorId) })
          .where({
            documentID_ID: documentId,
            sourceEntity: "DocumentHeaderStats",
          })
      );
    }

    if (obsoleteIds.length > 0) {
      await tx.run(
        DELETE.from(DocumentHeaderStats).where({ ID: { in: obsoleteIds } })
      );
    }

    if (DocumentFieldHistories) {
      await trackFieldChanges(tx, DocumentFieldHistories, {
        documentId,
        entityName: "DocumentHeaderStats",
        recordId: survivorId,
        existingRecord: survivor,
        updateData: headerStatsUpdatePayload,
        trackedFields: FIELD_TRACKING_TARGETS.DocumentHeaderStats || [],
        userEmail,
      });
    }

    await tx.run(
      UPDATE(DocumentHeaderStats)
        .set(headerStatsUpdatePayload)
        .where({ ID: survivorId })
    );
  } else if (headerStatsEntry) {
    await tx.run(INSERT.into(DocumentHeaderStats).entries(headerStatsEntry));

    // No prior row in the table, but legacy history rows may still point to
    // a UUID from an earlier DELETE+INSERT cycle. Re-point them to the new
    // ID so future tracking finds them.
    if (DocumentFieldHistories) {
      await tx.run(
        UPDATE(DocumentFieldHistories)
          .set({ sourceRecordId: String(headerStatsEntry.ID) })
          .where({
            documentID_ID: documentId,
            sourceEntity: "DocumentHeaderStats",
          })
      );
    }
  }

  const soldToEntries = toArray(payload.Nav_SoldTo)
    .filter(
      (option) =>
        option && (option.SoldToId || option.SoldToName || option.SoldToAddress)
    )
    .slice(0, MAX_PARTNER_OPTIONS)
    .map((option) => ({
      ID: cds.utils.uuid(),
      documentID_ID: documentId,
      soldToId: option.SoldToId || null,
      soldToName: option.SoldToName || null,
      soldToAddress: option.SoldToAddress || null,
      isSelected: option.IsSelected ?? option.isSelected ?? false,
    }));

  await tx.run(
    DELETE.from(DocumentSoldToOptions).where({ documentID_ID: documentId })
  );
  if (soldToEntries.length > 0) {
    await tx.run(INSERT.into(DocumentSoldToOptions).entries(soldToEntries));
  }

  const shipToEntries = toArray(payload.Nav_ShipTo)
    .filter(
      (option) =>
        option && (option.ShipToId || option.ShipToName || option.ShipToAddress)
    )
    .slice(0, MAX_PARTNER_OPTIONS)
    .map((option) => ({
      ID: cds.utils.uuid(),
      documentID_ID: documentId,
      shipToId: option.ShipToId || null,
      shipToName: option.ShipToName || null,
      shipToAddress: option.ShipToAddress || null,
      isSelected: option.IsSelected ?? option.isSelected ?? false,
    }));

  await tx.run(
    DELETE.from(DocumentShipToOptions).where({ documentID_ID: documentId })
  );
  if (shipToEntries.length > 0) {
    await tx.run(INSERT.into(DocumentShipToOptions).entries(shipToEntries));
  }

  if (DocumentMaterialOptions) {
    const materialEntries = toArray(payload.Nav_Material)
      .filter(
        (option) =>
          option &&
          (option.MaterialNo ||
            option.Material ||
            option.Description ||
            option.MaterialDescription)
      )
      .slice(0, MAX_PARTNER_OPTIONS)
      .map((option) => ({
        ID: cds.utils.uuid(),
        documentID_ID: documentId,
        materialNo: option.MaterialNo || option.Material || null,
        materialDescription: option.Description || option.MaterialDescription || null,
        isSelected: option.IsSelected ?? option.isSelected ?? false,
      }));

    await tx.run(
      DELETE.from(DocumentMaterialOptions).where({ documentID_ID: documentId })
    );
    if (materialEntries.length > 0) {
      await tx.run(
        INSERT.into(DocumentMaterialOptions).entries(materialEntries)
      );
    }
  }

  if (isPr1 && DocumentSalesOrgs) {
    const salesOrgEntries = toArray(payload.Nav_SalesOrg)
      .map((entry) => {
        if (!entry || typeof entry !== "object") {
          return null;
        }

        const region = toStringSafe(entry.Region ?? entry.region ?? "").trim();
        const salesOrg = toStringSafe(entry.SalesOrg ?? entry.salesOrg ?? "").trim();
        const description = toStringSafe(
          entry.Description ?? entry.description ?? ""
        ).trim();
        const disChannel = toStringSafe(
          entry.DisChannel ?? entry.disChannel ?? entry.DistributionChannel ?? ""
        ).trim();
        const division = toStringSafe(
          entry.Division ?? entry.division ?? ""
        ).trim();

        if (
          !region &&
          !salesOrg &&
          !description &&
          !disChannel &&
          !division
        ) {
          return null;
        }

        return {
          ID: cds.utils.uuid(),
          documentID_ID: documentId,
          Region: region || null,
          SalesOrg: salesOrg || null,
          Description: description || null,
          DisChannel: disChannel || null,
          Division: division || null,
        };
      })
      .filter((entry) => !!entry);

    await tx.run(
      DELETE.from(DocumentSalesOrgs).where({ documentID_ID: documentId })
    );

    if (salesOrgEntries.length > 0) {
      await tx.run(INSERT.into(DocumentSalesOrgs).entries(salesOrgEntries));
    }
  }

  // const itemStats = toArray(payload.Nav_ItemStat);
  const itemStatsPayload = isPr1 ? pr1Payload ?? payload : payload;
  const itemStats = toArray(itemStatsPayload.Nav_ItemStat);
  const itemStatsSource = itemStats.length > 0 ? itemStats : toArray(itemStatsPayload.Nav_Material);
    // itemStats.length > 0 ? itemStats : toArray(payload.Nav_Material);
  const fallbackDocumentDate = normalizeDateString(payload.DeliveryDate);
  for (const stat of itemStatsSource) {
    if (!stat) continue;

    const updateData = {};
    const materialNo = stat.MaterialNo || stat.Material;
    if (materialNo) {
      updateData.SAPMaterialNo = materialNo;
      // updateData.supplierMaterialNumber = stat.MaterialNo;
    }
    const description =
      stat.Description !== undefined && stat.Description !== null
        ? stat.Description
        : stat.MaterialDescription;
    if (description !== undefined && description !== null) {
      updateData.SAPMaterialDescription = description;
    }
    // if (stat.UOM !== undefined && stat.UOM !== null) {
    //   updateData.unitOfMeasure = stat.UOM;
    // }
    // if (stat.Quantity !== undefined && stat.Quantity !== null) {
    //   const parsedQuantity = parseDecimal(stat.Quantity);
    //   if (parsedQuantity !== null) {
    //     updateData.quantity = parsedQuantity;
    //   }
    // }
    if (stat.UnitPrice !== undefined && stat.UnitPrice !== null) {
      const parsedUnitPrice = parseDecimal(stat.UnitPrice);
      if (parsedUnitPrice !== null) {
        updateData.SAPUnitPrice = parsedUnitPrice;
      }
    }
    if (description !== undefined && description !== null) {
      updateData.SAPMaterialDescription = description;
    }
    if (stat.ItemCategory !== undefined && stat.ItemCategory !== null) {
      updateData.ItemCategory = stat.ItemCategory;
    }
    if (stat.Plant !== undefined && stat.Plant !== null) {
      updateData.Plant = stat.Plant;
    }
    if (stat.Route !== undefined && stat.Route !== null) {
      updateData.Route = stat.Route;
    }
    if (stat.TPDate !== undefined && stat.TPDate !== null) {
      updateData.TPDate = normalizeDateString(stat.TPDate);
    }
    if (stat.MSDate !== undefined && stat.MSDate !== null) {
      updateData.MSDate = normalizeDateString(stat.MSDate);
    }
    if (stat.LoadDate !== undefined && stat.LoadDate !== null) {
      updateData.LoadDate = normalizeDateString(stat.LoadDate);
    }
    if (stat.GIDate !== undefined && stat.GIDate !== null) {
      updateData.GIDate = normalizeDateString(stat.GIDate);
    }
    if (isPr1) {
      if (stat.Postx !== undefined && stat.Postx !== null) {
        const sapCustMatDesc = toStringSafe(stat.Postx).trim();
        updateData.SAPCustMatDesc = sapCustMatDesc || null;
      }
      if (stat?.Kdmat !== undefined && stat?.Kdmat !== null) {
        const sapCustMatNum = toStringSafe(stat.Kdmat).trim();
        updateData.SAPCustMatNum = sapCustMatNum || null;
      }

      if (stat.PackAvl !== undefined && stat.PackAvl !== null){
        const PackAvl = toStringSafe(stat.PackAvl).trim();
        updateData.PackAvl = PackAvl || null;
      }

      if (stat.UOM !== undefined && stat.UOM !== null) {
        const sapUnitOfMeasure = toStringSafe(stat.UOM).trim();
        updateData.SAPUnitOfMeasure = sapUnitOfMeasure || null;
      }
    }

    const itemNumber = parseItemNumber(stat.ItemNumber);
    const whereClause = { documentID_ID: documentId };
    if (Number.isInteger(itemNumber)) {
      whereClause.itemNumber = itemNumber;
    } else if (materialNo) {
      whereClause.SAPMaterialNo = materialNo;
    }

    const existingItem = await tx.run(
      SELECT.one
        .from(DocumentLineItems)
        .columns("ID", "documentDate")
        .where(whereClause)
    );

    if (!existingItem) {
      continue;
    }

    if (!existingItem.documentDate && fallbackDocumentDate) {
      updateData.documentDate = fallbackDocumentDate;
    }

    if (Object.keys(updateData).length === 0) {
      continue;
    }

    await tx.run(
      UPDATE(DocumentLineItems).set(updateData).where({ ID: existingItem.ID })
    );
  }
}

export function applyDuplicateCreationGuard(req, status, items, filterFn) {
  if (status === "COMPLETED") {
    req.error(409, "Cannot create orders: document is already COMPLETED.");
    return null;
  }

  const activeItems = status === "PENDING" ? items.filter(filterFn) : items;

  if (activeItems.length === 0) {
    req.error(409, "Cannot create orders: all line items already have a Sales Order.");
    return null;
  }

  return activeItems;
}

export const persistanceODataCreateResult = async ({
  req,
  result,
  resultList = [],
  individualCreation = false,
  requestData = {},
  documentIdForLogs = null,
  lineItemsForUpdate = [],
  documentSystem = "PR1",
  payloadFromDb = false,
  creationType = "Manual",
  orderCreatedBy = "system",
}) => {
  const getSalesOrderFromResponse = (response) => {
    let salesOrder = toStringSafe(response?.SalesOrder);

    if (!salesOrder) {
      const navReturns = ensureArray(response?.Nav_Return);
      const successReturn = navReturns.find(
        (entry) => entry?.Type === "S" && toStringSafe(entry?.Number) === "311"
      );

      if (successReturn) {
        salesOrder = extractSalesOrderFromMessage(successReturn.Message);
      }
    }

    return salesOrder;
  };

  const hasTrainingSuccessReturn = (navReturns = []) =>
    ensureArray(navReturns).some(
      (entry) => entry?.Type === "I" && toStringSafe(entry?.Number) === "027"
    );

  const isSuccessfulOrderCreation = (response) => {
    const navReturns = ensureArray(response?.Nav_Return);
    const hasErrors = navReturns.some((entry) => entry?.Type === "E");
    if (hasErrors) {
      return false;
    }

    const salesOrder = getSalesOrderFromResponse(response);
    if (salesOrder) {
      return true;
    }

    return hasTrainingSuccessReturn(navReturns);
  };

  const resolveLineItemIdsForUpdate = (itemsSource = []) =>
    ensureArray(itemsSource)
      .map((item) => toStringSafe(item?.ID))
      .filter(Boolean);

  const documentIdForUpdates =
    toStringSafe(requestData?.ID) || documentIdForLogs;

  if (individualCreation) {
    const responses = ensureArray(resultList);
    const isPR1System = toStringSafe(documentSystem).toUpperCase() === "PR1";
    let createdCount = 0;

    const navReturnAggregated = responses.flatMap((response, index) => {
      const itemNumber = toStringSafe(response?.ItemNumber);
      const lineItemId =
        response?.lineItemId ?? lineItemsForUpdate[index]?.ID;
      const navReturns = ensureArray(response?.Nav_Return);
      const taskStatus = extractResultStatus(response);
      const isSuccess = isSuccessfulOrderCreation(response);

      if (isSuccess) {
        createdCount += 1;
        const salesOrder = getSalesOrderFromResponse(response);
        const typeEntry = navReturns.find((entry) => entry?.Type)?.Type;
        return [{
          Type: toStringSafe(typeEntry),
          ItemNumber: itemNumber,
          SalesOrder: salesOrder,
          lineItemId,
          isSuccess: true,
        }];
      }

      // TaskStatus SUCCESS pero Nav_Return con errores Type "E":
      // el task ya terminó (no es pending), devolver cada error con Row = itemNumber enviado.
      if (taskStatus === "SUCCESS") {
        const errorEntries = navReturns.filter(
          (entry) => toStringSafe(entry?.Type).toUpperCase() === "E"
        );
        if (errorEntries.length > 0) {
          return errorEntries.map((error) => ({
            Type: toStringSafe(error.Type),
            Id: toStringSafe(error.Id ?? error.ID ?? error.id),
            Number: toStringSafe(error.Number),
            Message: toStringSafe(error.Message),
            Row: itemNumber,
            ItemNumber: itemNumber,
            lineItemId,
            isSuccess: false,
          }));
        }
      }

      const typeEntry = navReturns.find((entry) => entry?.Type)?.Type;
      return [{
        Type: toStringSafe(typeEntry),
        ItemNumber: itemNumber,
        SalesOrder: "",
        lineItemId,
        isSuccess: false,
      }];
    });

    const hasPendingResponses = responses.some(
      (response) => extractResultStatus(response) === "PENDING"
    );

    let status;
    if (createdCount === responses.length) {
      status = "COMPLETED";
    } else if (hasPendingResponses) {
      status = "PENDING";
    } else if (isPR1System) {
      // PR1: every task finished (no PENDING). Even if no SO was created the
      // creation flow is done; the per-item errors live in Nav_Return.
      status = "COMPLETED";
    } else {
      status = "PENDING";
    }

    if (documentIdForUpdates) {
      const db = await cds.connect.to("db");
      const { DocumentErrorLogs, DocumentLineItems, Documents, DocumentFieldHistories } = cds.entities("soautomation");

      if (payloadFromDb && DocumentErrorLogs) {
        const aggregatedErrorEntries = responses.flatMap((response) => {
          const navReturns = ensureArray(response?.Nav_Return);
          const logEntries = isPR1System
            ? navReturns
            : navReturns.filter((entry) => entry?.Type === "E");
          return logEntries
            .filter((entry) => entry && typeof entry === "object")
            .map((error) => ({
              ID: cds.utils.uuid(),
              documentID_ID: documentIdForUpdates,
              type: toStringSafe(error.Type),
              message: toStringSafe(error.Message),
              number: toStringSafe(error.Number),
              source: isPR1System ? "CREATE" : null,
            }));
        });

        await db.run(
          DELETE.from(DocumentErrorLogs).where({ documentID_ID: documentIdForUpdates })
        );

        if (aggregatedErrorEntries.length > 0) {
          await db.run(INSERT.into(DocumentErrorLogs).entries(aggregatedErrorEntries));
        }
      }

      if (DocumentLineItems) {
        const successfulEntries = navReturnAggregated.filter(
          (entry) => entry.isSuccess && entry.lineItemId
        );

        const existingLineItemsForTracking = DocumentFieldHistories && successfulEntries.length > 0
          ? await db.run(
              SELECT.from(DocumentLineItems)
                .columns("ID", "SalesOrder", "orderCreatedBy")
                .where({ ID: { in: successfulEntries.map(e => e.lineItemId) } })
            )
          : [];
        const existingLineItemMap = new Map(
          ensureArray(existingLineItemsForTracking).map(r => [toStringSafe(r.ID), r])
        );

        const updatePromises = successfulEntries.map((entry) =>
          db.run(
            UPDATE(DocumentLineItems)
              .set({
                orderCreatedBy,
                ...(entry.SalesOrder ? { SalesOrder: entry.SalesOrder } : {}),
              })
              .where({ ID: entry.lineItemId, documentID_ID: documentIdForUpdates })
          )
        );

        await Promise.all(updatePromises);

        if (DocumentFieldHistories) {
          const lineItemTrackedFields = FIELD_TRACKING_TARGETS.DocumentLineItems || [];
          await Promise.all(successfulEntries.map(entry => {
            const lineItemUpdate = {
              orderCreatedBy,
              ...(entry.SalesOrder ? { SalesOrder: entry.SalesOrder } : {}),
            };
            return trackFieldChanges(db, DocumentFieldHistories, {
              documentId: documentIdForUpdates,
              entityName: "DocumentLineItems",
              recordId: entry.lineItemId,
              existingRecord: existingLineItemMap.get(toStringSafe(entry.lineItemId)) || {},
              updateData: lineItemUpdate,
              trackedFields: lineItemTrackedFields,
              userEmail: resolveUserEmail(req),
            });
          }));
        }

        const stampableIds = successfulEntries
          .filter((entry) => Boolean(toStringSafe(entry.SalesOrder)))
          .map((entry) => entry.lineItemId);
        if (stampableIds.length > 0) {
          await stampLineItemCompletion(
            db,
            documentIdForUpdates,
            resolveUserEmail(req),
            stampableIds
          );
        }

        const documentLineItems =
          (await db.run(
            SELECT.from(DocumentLineItems).where({ documentID_ID: documentIdForUpdates })
          )) || [];

        const hasSalesOrder = (item) => Boolean(toStringSafe(item.SalesOrder));
        const hasProcessedLineItem = (item) =>
          hasSalesOrder(item) || Boolean(toStringSafe(item.orderCreatedBy));
        const allCompletedOrDeleted = documentLineItems.every(
          (item) => hasProcessedLineItem(item) || item.deleted === true
        );
        const anyProcessedLineItem = documentLineItems.some((item) =>
          hasProcessedLineItem(item)
        );
        const anyMissingNonDeleted = documentLineItems.some(
          (item) => !hasProcessedLineItem(item) && item.deleted !== true
        );
        const hasLineItems = documentLineItems.length > 0;

        let documentStatus = "NEW";
        if (hasLineItems && allCompletedOrDeleted) {
          documentStatus = "COMPLETED";
        } else if (hasLineItems && anyProcessedLineItem && anyMissingNonDeleted) {
          documentStatus = "PENDING";
        }

        if (Documents) {
          const documentUpdates = { status: documentStatus };
          if (createdCount > 0) {
            documentUpdates.creationType = creationType;
          }

          const existingDocForTracking = DocumentFieldHistories
            ? await db.run(SELECT.one.from(Documents).columns("ID", "status").where({ ID: documentIdForUpdates }))
            : null;

          await db.run(
            UPDATE(Documents)
              .set(documentUpdates)
              .where({ ID: documentIdForUpdates })
          );

          if (DocumentFieldHistories && existingDocForTracking) {
            await trackFieldChanges(db, DocumentFieldHistories, {
              documentId: documentIdForUpdates,
              entityName: "Documents",
              recordId: documentIdForUpdates,
              existingRecord: existingDocForTracking,
              updateData: documentUpdates,
              trackedFields: FIELD_TRACKING_TARGETS.Documents || [],
              userEmail: resolveUserEmail(req),
            });
          }

          if (documentStatus === "COMPLETED") {
            await stampDocumentCompletion(db, documentIdForUpdates, resolveUserEmail(req));
          }
        }
      }
    }

    return {
      status,
      message: `Created ${createdCount}/${responses.length}`,
      Nav_Return: navReturnAggregated,
      ...(isPR1System
        ? {
          pendingItems: responses
            .map((response) => ({
              taskId: extractTaskId(response),
              taskStatus: extractResultStatus(response),
            }))
            .filter(({ taskId, taskStatus }) => Boolean(taskId) && taskStatus === "PENDING")
            .map(({ taskId }) => taskId),
        }
        : {}),
    };
  }

  if (!documentIdForUpdates) {
    return result;
  }

  const navReturns = ensureArray(result?.Nav_Return);
  const isPR1System = toStringSafe(documentSystem).toUpperCase() === "PR1";
  const logEntries = isPR1System
    ? navReturns
    : navReturns.filter((entry) => entry?.Type === "E");
  const successfulCreation = isSuccessfulOrderCreation(result);
  const db = await cds.connect.to("db");
  const { DocumentErrorLogs, DocumentLineItems, Documents, DocumentFieldHistories } = cds.entities("soautomation");

  if (payloadFromDb && DocumentErrorLogs) {
    await db.run(
      DELETE.from(DocumentErrorLogs).where({ documentID_ID: documentIdForUpdates })
    );

    if (logEntries.length > 0) {
      const errorEntries = logEntries.map((error) => ({
        ID: cds.utils.uuid(),
        documentID_ID: documentIdForUpdates,
        type: toStringSafe(error.Type),
        message: toStringSafe(error.Message),
        number: toStringSafe(error.Number),
        source: isPR1System ? "CREATE" : null,
      }));

      await db.run(INSERT.into(DocumentErrorLogs).entries(errorEntries));
      if (!isPR1System) {
        return result;
      }
    }
  }

  const salesOrder = getSalesOrderFromResponse(result);
  const lineItemIdsForUpdate = resolveLineItemIdsForUpdate(lineItemsForUpdate);
  const hasLineItemsToUpdate = lineItemIdsForUpdate.length > 0;
  if (successfulCreation && DocumentLineItems) {
    const lineItemUpdate = {
      orderCreatedBy,
      ...(salesOrder ? { SalesOrder: salesOrder } : {}),
    };

    const whereClause = hasLineItemsToUpdate
      ? { documentID_ID: documentIdForUpdates, ID: { in: lineItemIdsForUpdate } }
      : { documentID_ID: documentIdForUpdates };

    const existingLineItemsForTracking = DocumentFieldHistories
      ? await db.run(
          SELECT.from(DocumentLineItems)
            .columns("ID", "SalesOrder", "orderCreatedBy")
            .where(whereClause)
        )
      : [];

    await db.run(
      UPDATE(DocumentLineItems)
        .set(lineItemUpdate)
        .where(whereClause)
    );

    if (DocumentFieldHistories) {
      const lineItemTrackedFields = FIELD_TRACKING_TARGETS.DocumentLineItems || [];
      await Promise.all(
        ensureArray(existingLineItemsForTracking).map(existing =>
          trackFieldChanges(db, DocumentFieldHistories, {
            documentId: documentIdForUpdates,
            entityName: "DocumentLineItems",
            recordId: existing.ID,
            existingRecord: existing,
            updateData: lineItemUpdate,
            trackedFields: lineItemTrackedFields,
            userEmail: resolveUserEmail(req),
          })
        )
      );
    }

    if (salesOrder) {
      await stampLineItemCompletion(
        db,
        documentIdForUpdates,
        resolveUserEmail(req),
        hasLineItemsToUpdate ? lineItemIdsForUpdate : null
      );
    }

    if (Documents) {
      const existingDocForTracking = DocumentFieldHistories
        ? await db.run(SELECT.one.from(Documents).columns("ID", "status").where({ ID: documentIdForUpdates }))
        : null;

      await db.run(
        UPDATE(Documents)
          .set({ status: "COMPLETED", creationType })
          .where({ ID: documentIdForUpdates })
      );

      if (DocumentFieldHistories && existingDocForTracking) {
        await trackFieldChanges(db, DocumentFieldHistories, {
          documentId: documentIdForUpdates,
          entityName: "Documents",
          recordId: documentIdForUpdates,
          existingRecord: existingDocForTracking,
          updateData: { status: "COMPLETED" },
          trackedFields: FIELD_TRACKING_TARGETS.Documents || [],
          userEmail: resolveUserEmail(req),
        });
      }

      await stampDocumentCompletion(db, documentIdForUpdates, resolveUserEmail(req));
    }
  }

  return result;
};

export function sanitizeNumericValue(value) {
  if (typeof value !== "string") return value;
  // Elimina separadores de miles (,) y convierte comas decimales si existieran
  const clean = value.replace(/,/g, "");
  const num = Number(clean);
  return isNaN(num) ? value : num;
}

export function convertUoM(uom, system) {
  if (!uom) return "";
  // const val = String(uom).trim().toUpperCase();
  const val = String(uom).trim();
  const isPr1System = String(system || "").toUpperCase() === "PR1";

  // if (val === "KGM") return "KG";
  // if (val === "LBR") return "LBS";
  // return val;
  return isPr1System ? val.toUpperCase() : val;
};

export function sanitizeQuantityValue(value) {
  // 100,000.01
  if (typeof value === "string") {
    const match = value.match(/-?[\d.,]+/);
    if (!match) return null;

    let numericStr = match[0];

    const hasDot = numericStr.includes(".");
    const hasComma = numericStr.includes(",");

    if (hasDot && hasComma) {
      const lastDot = numericStr.lastIndexOf(".");
      const lastComma = numericStr.lastIndexOf(",");
      if (lastDot > lastComma) {
        numericStr = numericStr.replace(/,/g, "");
      } else {
        numericStr = numericStr.replace(/\./g, "").replace(/,/g, ".");
      }
    }

    else if (hasComma) {
      const parts = numericStr.split(",");
      const decimals = parts[1] || "";

      if (parts.length > 2) {
        numericStr = numericStr.replace(/,/g, "");
      }
      else if (parts.length === 2) {
        if (decimals.length === 3) {
          numericStr = numericStr.replace(/,/g, "");
        } else {
          numericStr = numericStr.replace(/,/g, ".");
        }
      }
    }
    if (numericStr.includes(".")) {
      let [intPart, decPart = ""] = numericStr.split(".");
      decPart = decPart.substring(0, 3);
      numericStr = decPart.length > 0 ? `${intPart}.${decPart}` : intPart;
    }

    const num = Number(numericStr);
    return Number.isNaN(num) ? null : num;
  }

  if (typeof value === "number") return value;
  return null;
}




// export function normalizeDate(value) {
//   if (value === undefined || value === null || value === "") {
//     return "";
//   }
//   if (value instanceof Date) {
//     return value.toISOString().slice(0, 10);
//   }
//   const str = String(value).trim();
//   if (!str) {
//     return "";
//   }
//   if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
//     return str;
//   }
//   const parsed = new Date(str);
//   if (Number.isNaN(parsed.getTime())) {
//     return str;
//   }
//   return parsed.toISOString().slice(0, 10);
// };

export function normalizeDate(value) {
  if (value === undefined || value === null || value === "") {
    return "";
  }

  if (value instanceof Date) {
    return value.toISOString().slice(0, 10).replace(/-/g, "");
  }

  const str = String(value).trim();
  if (!str) {
    return "";
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    return str.replace(/-/g, "");
  }

  const parsed = new Date(str);
  if (Number.isNaN(parsed.getTime())) {
    return str; // No es una fecha válida, se devuelve como vino
  }
  return parsed.toISOString().slice(0, 10).replace(/-/g, "");
};


export function ensureArray(value) { return (Array.isArray(value) ? value : []) };

export async function fetchItemHistoryMap(
  documentId,
  sourceIds = [],
  fieldNames = ["SAPMaterialNo", "customerMaterialNumber", "unitOfMeasure", "quantity"]
) {
  const entities = cds.entities("soautomation") || {};
  const { DocumentFieldHistories } = entities;

  if (!documentId || !DocumentFieldHistories || sourceIds.length === 0) {
    return new Map();
  }

  const db = await cds.connect.to("db");
  const historyRecords = await db.run(
    SELECT.from(DocumentFieldHistories)
      .columns("sourceRecordId", "fieldName", "originalValue")
      .where({
        documentID_ID: documentId,
        sourceEntity: "DocumentLineItems",
        sourceRecordId: { in: sourceIds.map((id) => toStringSafe(id)) },
        fieldName: { in: fieldNames },
      })
  );

  const historyMap = new Map();
  ensureArray(historyRecords).forEach((record) => {
    const sourceId = toStringSafe(record.sourceRecordId);
    const existing = historyMap.get(sourceId) || {};
    existing[record.fieldName] = record.originalValue;
    historyMap.set(sourceId, existing);
  });

  return historyMap;
}

const normalizeOptionalLogId = (value) => {
  if (value === undefined || value === null) {
    return null;
  }

  const stringValue = toStringSafe(value).trim();
  if (!stringValue) {
    return null;
  }

  return /^\d+$/.test(stringValue) ? Number(stringValue) : stringValue;
};

export async function fetchDocumentForOData(attachmentId, instanceId, req, logId = null) {
  const db = await cds.connect.to("db");
  const { Documents, DocumentHeaders, DocumentHeaderStats, DocumentLineItems } = cds.entities("soautomation");
  const normalizedLogId = normalizeOptionalLogId(logId);
  const documentWhere = normalizedLogId === null
    ? { attachmentId, instanceId }
    : { attachmentId, instanceId, LogId: normalizedLogId };

  const document = await db.run(
    SELECT.one
      .from(Documents)
      .columns("ID", "attachmentId", "instanceId", "fileName", "system", "subject", "training")
      .where(documentWhere)
  );

  if (!document) {
    const withLogIdMessage = normalizedLogId !== null
      ? ` and logId ${normalizedLogId}`
      : "";
    req.error(
      404,
      `Document with attachmentId ${attachmentId}, instanceId ${instanceId}${withLogIdMessage} not found`
    );
    return null;
  }

  const documentId = document.ID;

  const header =
    (await db.run(
      SELECT.one.from(DocumentHeaders).where({ documentID_ID: documentId })
    )) || {};

  const headerStats =
    (await db.run(
      SELECT.one.from(DocumentHeaderStats).where({ documentID_ID: documentId })
    )) || {};

  const lineItems =
    (await db.run(
      SELECT.from(DocumentLineItems)
        .where({ documentID_ID: documentId })
        .orderBy("itemNumber")
    )) || [];

  return { header, headerStats, lineItems, documentId, document };
};

export function buildPr1ODataPayload(basePayload = {}) {
  const payload = { ...basePayload };


  const extraHeaderFields = {
    SenderExtAddressPart: basePayload.SenderExtAddressPart || basePayload.SenderExtAddresPart || "",
    ShipToExtraAddressPart: basePayload.ShipToExtraAddressPart || "",
    ShipToPostalCode: basePayload.ShipToPostalCode || "",
  };

  // Delete specific keys from LP1
  delete payload.Nav_Return;
  delete payload.Nav_SalesData;

  // Change CustomerMaterialNumber to CustomerMaterialNum
  payload.Nav_LineItem?.forEach(item => {
    if ("CustomerMaterialNumber" in item) {
      item.CustomerMatNum = item.CustomerMaterialNumber;
      delete item.CustomerMaterialNumber;
    }
    if ("SupplierMaterialNumber" in item) {
      item.SupplierMatNum = item.SupplierMaterialNumber;
      delete item.SupplierMaterialNumber;
    }
    if ("ReqDate" in item) {
      item.DocumentDate = item.ReqDate;
      delete item.ReqDate;
    }
  });


  Object.entries(extraHeaderFields).forEach(([key, value]) => {
    if (!Object.prototype.hasOwnProperty.call(payload, key)) {
      payload[key] = value;
    }
  });

  const extraNavs = {
    Nav_BillTo: [{}],
    Nav_Payer: [{}],
    Nav_SalesOrg: [{}],
    Nav_Return: [{}],
  };

  Object.entries(extraNavs).forEach(([key, value]) => {
    if (!payload[key]) {
      payload[key] = value;
    }
  });

  if (!Object.prototype.hasOwnProperty.call(payload, "TaskID")) {
    payload.TaskID = "";
  }
  if (!Object.prototype.hasOwnProperty.call(payload, "TaskStatus")) {
    payload.TaskStatus = "";
  }

  return payload;
};

export function enhancePr1SimulatePayload(basePayload = {}) {
  const payload = { ...basePayload };

  if (!payload.PriceDate) {
    payload.PriceDate = "";
  }
  if (!Object.prototype.hasOwnProperty.call(payload, "SalesGroup")) {
    payload.SalesGroup = "";
  }
  if (!Object.prototype.hasOwnProperty.call(payload, "PriceGroup")) {
    payload.PriceGroup = "";
  }
  if (!Object.prototype.hasOwnProperty.call(payload, "IncoTerm1")) {
    payload.IncoTerm1 = "";
  }
  if (!Object.prototype.hasOwnProperty.call(payload, "IncoTerm2")) {
    payload.IncoTerm2 = "";
  }
  if (!Object.prototype.hasOwnProperty.call(payload, "ReqDate")) {
    payload.ReqDate = "";
  }

  const baseDocumentNumber = payload.DocumentNumber || "";

  payload.Nav_SimItem = ensureArray(payload.Nav_SimItem).map((item) => ({
    DocumentNumber: item.DocumentNumber || baseDocumentNumber,
    ItemNumber: item.ItemNumber || "",
    Material: item.Material || "",
    Description: item.Description || "",
    NetAmount: item.NetAmount || "",
    Quantity: item.Quantity || "",
    UnitPrice: item.UnitPrice || "",
    DocumentDate: item.DocumentDate || payload.DocumentDate || "",
    DeliveryDate: item.DeliveryDate || item.ReqDate || payload.ReqDate || "",
    ReqDate: item.ReqDate || item.DocumentDate || payload.ReqDate || "",
    MSDate: item.MSDate || "",
    CurrencyCode: item.CurrencyCode || payload.CurrencyCode || "",
    SupplierMatNum: item.SupplierMatNum || "",
    CustomerMatNum: item.CustomerMatNum || "",
    UnitOfMeasure: item.UnitOfMeasure || "",
    Plant: item.Plant || "",
    ItemCategory: item.ItemCategory || "",
    Route: item.Route || "",
    Kdkg1: item.Kdkgl || "",
    POItemNumber: item.POItemNumber || "",
  }));

  if (!payload.Nav_PriceSim) {
    payload.Nav_PriceSim = [{}];
  }
  if (!payload.Nav_SimuAddPriceCond) {
    payload.Nav_SimuAddPriceCond = [{}];
  }
  if (!payload.Nav_SimText) {
    payload.Nav_SimText = [{}];
  }
  if (!payload.Nav_SimuCreateText) {
    payload.Nav_SimuCreateText = [{}];
  }

  if (payload.EmailBox) delete payload.EmailBox
  if (payload.SendingEmail) delete payload.SendingEmail
  if (payload.LogId) delete payload.LogId

  return payload;
}

export async function buildODataPayloadFromDb(attachmentId, instanceId, req, logId = null) {
  const documentData = await fetchDocumentForOData(attachmentId, instanceId, req, logId);
  if (!documentData) {
    return null;
  }

  const {
    header = {},
    headerStats = {},
    lineItems = [],
    documentId,
    document,
  } = documentData;
  // const isPr1 = (document?.system || "").toUpperCase() === "PR1";
  const isPr1 = String(document?.system ?? "").toUpperCase() === "PR1";
  const fallbackReqDate = normalizeDate(header?.deliveryDate);

  const excludedFields = ["addfielditem1", "addfielditem2", "addfielditem3"];

  const allowedHeaderKeys = new Set(
    Object.keys(REQUIRED_ECC_HEADER_FIELDS)
      .map((key) => key.toLowerCase())
      .concat(["documentnumber", "purchaseorder"])
  );

  const headerObj = {};

  const mapSourceToHeader = (source) => {
    Object.entries(source || {}).forEach(([key, value]) => {
      if (value === undefined || value === null) {
        return;
      }

      let normalizedKey = normalizeLabel(key);
      if (!normalizedKey) return;

      if (excludedFields.includes(normalizedKey.toLowerCase())) {
        return;
      }

      if (
        normalizedKey === "senderextraaddrespart" ||
        normalizedKey === "senderextraaddresspart"
      ) {
        normalizedKey = "senderextaddresspart";
      }

      const normalizedKeyLower = normalizedKey.toLowerCase();
      if (!allowedHeaderKeys.has(normalizedKeyLower)) {
        return;
      }

      const finalKey = toTitleCase(normalizedKey);
      let finalValue = value;

      if (normalizedKeyLower === "quantity") {
        const sanitizedQuantity = sanitizeQuantityValue(value);
        finalValue =
          sanitizedQuantity !== null && sanitizedQuantity !== undefined
            ? String(sanitizedQuantity)
            : value !== undefined && value !== null
              ? String(value)
              : "";
      } else if (normalizedKeyLower === "netamount") {
        finalValue = formatAmountValue(value);
      }

      headerObj[finalKey] = toStringSafe(finalValue);

    });
  };

  mapSourceToHeader(headerStats);
  mapSourceToHeader(header);

  if (isPr1) {
    const internalValueFromDb = pickValue(header, ["internal", "Internal"]);
    if (internalValueFromDb !== undefined && internalValueFromDb !== null) {
      headerObj.Internal = toStringSafe(internalValueFromDb);
    }

    const vendorCountryCodeFromDb = pickValue(header, ["vendorCountryCode", "VendorCountryCode"]);
    if (vendorCountryCodeFromDb !== undefined && vendorCountryCodeFromDb !== null) {
      headerObj.VendorCountryCode = toStringSafe(vendorCountryCodeFromDb);
    }

    const salesOrgFromDb = pickValue(header, ["dtmSalesOrg", "DtmSalesOrg"]);
    if (salesOrgFromDb !== undefined && salesOrgFromDb !== null) {
      headerObj.SalesOrg = toStringSafe(salesOrgFromDb);
    }
  }

  if (headerObj.DocumentNumber) {
    headerObj.PurchaseOrder = headerObj.DocumentNumber;
    delete headerObj.DocumentNumber;
  }

  const eccHeader = { ...REQUIRED_ECC_HEADER_FIELDS, ...headerObj };

  if (!eccHeader.SenderExtAddressPart) {
    if (eccHeader.SenderExtraAddressPart) {
      eccHeader.SenderExtAddressPart = eccHeader.SenderExtraAddressPart;
    } else if (eccHeader.SenderExtraAddresPart) {
      eccHeader.SenderExtAddressPart = eccHeader.SenderExtraAddresPart;
    }
  }

  delete eccHeader.SenderExtraAddressPart;
  delete eccHeader.SenderExtraAddresPart;
  delete eccHeader.SenderExtAddresPart;

  const itemFieldMapping = {
    quantity: "Quantity",
    netamount: "NetAmount",
    unitprice: "UnitPrice",
    description: "Description",
    currencycode: "CurrencyCode",
    documentdate: "ReqDate",
    unitofmeasure: "UnitOfMeasure",
    customermaterialnumber: "CustomerMaterialNumber",
    documentnumber: "DocumentNumber",
    suppliermaterialnumber: "SupplierMaterialNumber",
  };

  const navLineItems = ensureArray(lineItems)
    .filter((item) => !item?.deleted)
    .map((item, index) => {
      const itemObj = {};

      Object.entries(item || {}).forEach(([key, value]) => {
        const normalizedKey = normalizeLabel(key);
        if (!normalizedKey) return;

        const normalizedLower = normalizedKey.toLowerCase();
        if (excludedFields.includes(normalizedLower) || normalizedLower === "itemnumber") {
          return;
        }

        const mappedKey = itemFieldMapping[normalizedLower];
        if (!mappedKey) {
          return;
        }

        let finalValue = value;
        if (normalizedLower === "quantity") {
          const sanitizedQuantity = sanitizeQuantityValue(value);
          finalValue =
            sanitizedQuantity !== null && sanitizedQuantity !== undefined
              ? String(sanitizedQuantity)
              : value !== undefined && value !== null
                ? String(value)
                : "";
        } else if (normalizedLower === "netamount" || normalizedLower === "unitprice") {
          finalValue = formatAmountValue(value);
        }

        itemObj[mappedKey] = toStringSafe(finalValue ?? "");
      });

      const sequentialItemNumber = (index + 1) * 10;
      itemObj["ItemNumber"] = String(sequentialItemNumber);

      if (isPr1) {
        const itemReqDate = normalizeDate(item?.documentDate) || fallbackReqDate || "";
        itemObj.ReqDate = toStringSafe(itemReqDate);
      }

      const requiredItemFields = [
        "Quantity",
        "NetAmount",
        "UnitPrice",
        "ItemNumber",
        "Description",
        "CurrencyCode",
        "DocumentDate",
        "UnitOfMeasure",
        "CustomerMaterialNumber",
        "DocumentNumber",
        "SupplierMatNum",
      ];

      if (isPr1 && !itemObj.ReqDate) {
        itemObj.ReqDate = "";
      }

      for (const field of requiredItemFields) {
        if (!itemObj[field]) itemObj[field] = "";
      }

      return itemObj;
    });

  const [emailData, logMetadata] = await Promise.all([
    fetchDocumentEmails(documentId),
    fetchDocumentLogMetadata(documentId),
  ]);

  let payload = {
    ...eccHeader,
    Nav_ShipTo: [{}],
    Nav_SoldTo: [{}],
    Nav_ItemStat: [{}],
    Nav_HeaderStat: [{}],
    Nav_Return: [{}],
    Nav_OrderType: [{}],
    Nav_SalesData: [{}],
    Nav_LineItem: navLineItems,
    ...emailData,
    LogId: logMetadata.LogId,
  };

  if (String(document?.system ?? "").toUpperCase() === "PR1") {
    payload = buildPr1ODataPayload(payload);
    payload.Subject = toStringSafe(document?.subject);
    payload.ShipToPostalCode = toStringSafe(header?.shipToPostalCode);
  } else {
    delete payload.ShipToPostalCode;
    payload.Subject = toStringSafe(document?.subject)
    payload.Nav_Material = [{}]
    payload.SenderPOBox = toStringSafe(header?.senderPoBox);
    payload.ShipToPOBox = toStringSafe(header?.shipToPoBox);
  }

  return {
    payload,
    documentSystem: document?.system || null,
  };
};

export function toStringSafe(value) {
  return value === undefined || value === null ? "" : String(value);
};

export function formatAmountValue(value) {
  if (value === undefined || value === null || value === "") {
    return "";
  }

  const numericValue = typeof value === "string" ? value.replace(/,/g, "") : value;
  const parsed = Number(numericValue);
  if (!Number.isNaN(parsed)) {
    return parsed.toFixed(2);
  }

  return toStringSafe(value);
};

export function formatItemNumber(value, index) {
  if (value === undefined || value === null || value === "") {
    return String((index + 1) * 10).padStart(6, "0");
  }
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    return toStringSafe(value);
  }
  return String(parsed).padStart(6, "0");
};


export function adjustZsdServiceForSystem(zsdService, payload, system) {
  if (!zsdService) return payload;

  if (system === "PR1") {
    zsdService.path = '/sap/opu/odata/sap/ZSD_SOA_SRV;o=R3';
    zsdService.destination = 'BTPSOALP';

    if (payload && Object.prototype.hasOwnProperty.call(payload, "SenderExtAddresPart")) {
      payload.SenderExtAddressPart = payload.SenderExtAddresPart;
      delete payload.SenderExtAddresPart;
    }

    console.log("Changed path to /sap/opu/odata/sap/ZSD_SOA_SRV;o=R3")
  } else {
    zsdService.path = '/sap/opu/odata/sap/ZSD_SOA_SRV';
    zsdService.destination = 'BTPSOALP';
    console.log("Changed path to /sap/opu/odata/sap/ZSD_SOA_SRV")
  }

  return payload;
}

// Hardcodeo temporal del usuario para pruebas en el sistema PR1.
// Para revertir, comenta ÚNICAMENTE la línea marcada abajo y todo seguirá funcionando.
export function applyHardcodedTestUser(payload, system) {
  if (!payload) return payload;

  const normalizedSystem = (system == null ? "" : String(system)).trim().toUpperCase();
  if (normalizedSystem !== "PR1") return payload;

  // payload.CurrentUser = "gxt5667"; // <-- Comenta esta línea para revertir el usuario hardcodeado

  return payload;
}


export function pickValue(source, keys) {
  for (const key of keys) {
    if (source && Object.prototype.hasOwnProperty.call(source, key)) {
      const value = source[key];
      if (value !== undefined && value !== null) {
        return value;
      }
    }
  }
  return undefined;
};


export function extractSalesOrderFromMessage(message) {
  const msg = toStringSafe(message);
  const match = msg.match(/\b\d+\b/);
  return match ? match[0] : "";
};

export function parseBooleanFlag(value) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    return value.trim().toLowerCase() === "true";
  }

  return false;
};

export async function fetchDocumentEmails(documentId) {
  if (!documentId) {
    return { EmailBox: "", SendingEmail: "" };
  }

  const db = await cds.connect.to("db");
  const { Documents } = cds.entities("soautomation");

  const documentRecord = await db.run(
    SELECT.one
      .from(Documents)
      .columns("emailSender", "emailFrom")
      .where({ ID: documentId })
  );

  if (!documentRecord) {
    return { EmailBox: "", SendingEmail: "" };
  }

  return {
    EmailBox: documentRecord.emailSender || "",
    SendingEmail: documentRecord.emailFrom || "",
  };
};

export async function fetchDocumentLogMetadata(documentId) {
  if (!documentId) {
    return { LogId: "", CCEmail: "" };
  }

  const db = await cds.connect.to("db");
  const { Documents, DocumentCCRecipients } = cds.entities("soautomation");

  const [documentRecord, ccRecipient] = await Promise.all([
    Documents
      ? db.run(
        SELECT.one
          .from(Documents)
          .columns("LogId")
          .where({ ID: documentId })
      )
      : null,
    DocumentCCRecipients
      ? db.run(
        SELECT.one
          .from(DocumentCCRecipients)
          .columns("email")
          .where({ documentID_ID: documentId })
          .orderBy("createdAt")
      )
      : null,
  ]);

  return {
    LogId: documentRecord?.LogId.toString() ?? "",
    CCEmail: ccRecipient?.email ?? "",
  };
};


// const normalizeTrackedValue = (value) => {
//   if (value === undefined || value === null) {
//     return null;
//   }

//   if (value instanceof Date) {
//     return value.toISOString();
//   }

//   return String(value);
// };
export async function fetchDoxExtraction(attachmentId, options = {}) {
  if (!attachmentId) {
    return null;
  }
  const useExtractedValues = options?.extractedValues !== false;

  const shouldPruneDoxField = (field) => {
    if (!field || typeof field !== "object") return false;

    const value = field.value;
    const rawValue = field.rawValue;
    const isBlank = (input) =>
      input === undefined ||
      input === null ||
      (typeof input === "string" && input.trim() === "");

    return isBlank(value) && isBlank(rawValue);
  };

  const sanitizeDoxExtraction = (data) => {
    if (!data || typeof data !== "object") return data;

    const extraction = data.extraction;
    if (!extraction || typeof extraction !== "object") return data;

    if (Array.isArray(extraction.headerFields)) {
      extraction.headerFields = extraction.headerFields.filter((field) => !shouldPruneDoxField(field));
    }

    if (Array.isArray(extraction.lineItems)) {
      extraction.lineItems = extraction.lineItems
        .map((itemGroup) => {
          if (!Array.isArray(itemGroup)) return itemGroup;
          return itemGroup.filter((field) => !shouldPruneDoxField(field));
        })
        .filter((itemGroup) => !Array.isArray(itemGroup) || itemGroup.length > 0);
    }

    return data;
  };

  const url = `/document/jobs/${attachmentId}?returnNullValues=true&extractedValues=${useExtractedValues ? "true" : "false"}&clientId=default`;

  const response = await executeHttpRequest(
    { destinationName: "doc_extractor" },
    {
      method: "GET",
      url,
    }
  );

  const responseData = response?.data || null;
  return sanitizeDoxExtraction(responseData);
};

const resolveSharePointFolderId = (environment) => {
  const env = (environment || "").toUpperCase();

  if (env === "DEV") {
    return process.env.SHAREPOINT_FOLDER_DEV || null;
  }

  if (env === "QAS") {
    return process.env.SHAREPOINT_FOLDER_QAS || null;
  }

  if (env === "PRD" || env === "PROD") {
    return process.env.SHAREPOINT_FOLDER_PROD || null;
  }

  return null;
};

const resolveEnvironmentFromUrl = (requestUrl) => {
  const hostnames = [];

  if (requestUrl) {
    hostnames.push(requestUrl);
  }

  if (process.env.VCAP_APPLICATION) {
    try {
      const vcap = JSON.parse(process.env.VCAP_APPLICATION);
      const appUris = vcap?.application_uris || vcap?.uris || [];
      if (Array.isArray(appUris)) {
        hostnames.push(...appUris);
      }
    } catch (err) {
      // Ignore parsing errors and rely on other sources.
    }
  }

  const devSubdomain = process.env.BTP_SUBDOMAIN_DEV?.toLowerCase();
  const qasSubdomain = process.env.BTP_SUBDOMAIN_QAS?.toLowerCase();
  const prdSubdomain = process.env.BTP_SUBDOMAIN_PRD?.toLowerCase();

  for (const candidate of hostnames) {
    if (!candidate) {
      continue;
    }

    try {
      const urlWithScheme = candidate.match(/^https?:\/\//)
        ? candidate
        : `https://${candidate}`;
      const parsedUrl = new URL(urlWithScheme);
      const hostname = parsedUrl.hostname.toLowerCase();

      if (hostname.includes("localhost") || hostname.startsWith("127.0.0.1")) {
        return "DEV";
      }

      const subdomain = hostname.split(".")[0].toLowerCase();

      if (devSubdomain && subdomain.includes(devSubdomain)) {
        return "DEV";
      }

      if (qasSubdomain && subdomain.includes(qasSubdomain)) {
        return "QAS";
      }

      if (prdSubdomain && subdomain.includes(prdSubdomain)) {
        return "PRD";
      }
    } catch (err) {
      continue;
    }
  }

  return null;
};

export function resolveDoxSubdomainUrl(requestUrl){
  const hostnames = [];

  if (requestUrl) {
    hostnames.push(requestUrl);
  }

  if (process.env.VCAP_APPLICATION) {
    try {
      const vcap = JSON.parse(process.env.VCAP_APPLICATION);
      const appUris = vcap?.application_uris || vcap?.uris || [];
      if (Array.isArray(appUris)) {
        hostnames.push(...appUris);
      }
    } catch (err) {
      // Ignore parsing errors and rely on other sources.
    }
  }

  const devSubdomain = process.env.DOX_SUBDOMAIN_DEV?.toLowerCase();
  const qasSubdomain = process.env.DOX_SUBDOMAIN_QAS?.toLowerCase();
  const prdSubdomain = process.env.DOX_SUBDOMAIN_PRD?.toLowerCase();

  for (const candidate of hostnames) {
    if (!candidate) {
      continue;
    }

    try {
      const urlWithScheme = candidate.match(/^https?:\/\//)
        ? candidate
        : `https://${candidate}`;
      const parsedUrl = new URL(urlWithScheme);
      const hostname = parsedUrl.hostname.toLowerCase();

      if (hostname.includes("localhost") || hostname.startsWith("127.0.0.1")) {
        return "DEV";
      }

      const subdomain = hostname.split(".")[0].toLowerCase();

      if (devSubdomain && subdomain.includes("dev")) {
        // return "DEV";
        return {
          environment: "DEV",
          baseUrl: process.env.DOX_SUBDOMAIN_DEV
        }
      }

      if (qasSubdomain && subdomain.includes("qas")) {
        // return "QAS";
        return {
          environment: "QAS",
          baseUrl: process.env.DOX_SUBDOMAIN_QAS
        }
      }

      if (prdSubdomain && (subdomain.includes("prd") || subdomain.includes("prod"))) {
        // return "PRD";
        return {
          environment: "PRD",
          baseUrl: process.env.DOX_SUBDOMAIN_PRD
        }
      }
    } catch (err) {
      continue;
    }
  }

  return null;
};

const buildSharePointFileName = (logId, originalFileName) => {
  // const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  // const timestamp = new Date().toISOString().split(".")[0]; // corta .123Z → queda YYYY-MM-DDTHH:MM:SS

  const timestamp = new Date().toISOString()
    .split(".")[0]        // YYYY-MM-DDTHH:MM:SS
    .replace(/:/g, "-"); // SharePoint-safe

  return `${logId}_${timestamp}_${originalFileName}`;
};

const resolveSharePointContentType = (fileName) => {
  return lookupMime(fileName) || "application/octet-stream";
};

export async function uploadDocumentAttachmentToSharePoint(options = {}) {
  const {
    attachmentId,
    logId,
    originalFileName,
    environment,
    requestUrl,
    documentId,
  } = options;

  if (!attachmentId || !documentId) {
    console.warn("SharePoint upload skipped: missing attachmentId or documentId.");
    return null;
  }

  if (!originalFileName || !logId) {
    console.warn("SharePoint upload skipped: missing originalFileName or logId.");
    return null;
  }

  const driveId = process.env.SHAREPOINT_DRIVE_ID;
  const resolvedEnvironment =
    (environment || resolveEnvironmentFromUrl(requestUrl) || "DEV").toUpperCase();
  const folderId = resolveSharePointFolderId(resolvedEnvironment);

  if (!driveId || !folderId) {
    console.warn("SharePoint upload skipped: missing driveId or folderId.");
    return null;
  }

  try {
    const downloadResponse = await executeHttpRequest(
      { destinationName: "doc_extractor" },
      {
        method: "GET",
        url: `/document/jobs/${attachmentId}/file`,
        responseType: "arraybuffer",
      }
    );

    const fileBuffer = Buffer.isBuffer(downloadResponse.data)
      ? downloadResponse.data
      : Buffer.from(downloadResponse.data);

    const fileName = buildSharePointFileName(logId, originalFileName);
    const contentType = resolveSharePointContentType(originalFileName || fileName);
    const encodedFileName = encodeURIComponent(fileName);

    const uploadResponse = await executeHttpRequest(
      { destinationName: "SHAREPOINT_IFF_SOA" },
      {
        method: "PUT",
        url: `/drives/${driveId}/items/${folderId}:/${encodedFileName}:/content`,
        data: fileBuffer,
        headers: {
          "Content-Type": contentType,
          Accept: "*/*",
        },
        responseType: "json",
      }
    );

    const item = uploadResponse?.data || {};
    const entities = cds.entities("soautomation") || {};
    const { DocumentAttachments } = entities;

    if (!DocumentAttachments) {
      return item;
    }

    const db = await cds.connect.to("db");

    const attachmentRecord = {
      attachmentId,
      sharepointItemId: item.id,
      driveId: item.parentReference?.driveId || driveId,
      folderId,
      name: item.name || fileName,
      webUrl: item.webUrl,
      createdDateTime: item.createdDateTime
        ? new Date(item.createdDateTime)
        : null,
      lastModifiedDateTime: item.lastModifiedDateTime
        ? new Date(item.lastModifiedDateTime)
        : null,
    };

    const existing = await db.run(
      SELECT.one.from(DocumentAttachments).where({
        documentID_ID: documentId,
        attachmentId,
      })
    );

    if (existing) {
      await db.run(
        UPDATE(DocumentAttachments)
          .set(attachmentRecord)
          .where({ ID: existing.ID })
      );
    } else {
      await db.run(
        INSERT.into(DocumentAttachments).entries({
          ID: cds.utils.uuid(),
          documentID_ID: documentId,
          ...attachmentRecord,
        })
      );
    }

    return item;
  } catch (error) {
    console.error(
      "SharePoint upload failed:",
      error?.message || error
    );
    return null;
  }
};

const FIELDS_TO_SKIP_CORRECTION = ["itemnumber"];

const formatDbValueForTraining = (value) => {
  if (value === undefined || value === null) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString().split("T")[0];
  }

  return String(value);
};

const updateFieldValueIfDifferent = (field, dbValue) => {
  const formattedDbValue = formatDbValueForTraining(dbValue);

  if (formattedDbValue === null) {
    return;
  }

  const existingValue = formatDbValueForTraining(
    field.value ?? field.rawValue ?? field.text
  );

  if (existingValue !== formattedDbValue) {
    field.value = formattedDbValue;
    field.rawValue = formattedDbValue;
  }
};

export function mergeExtractionWithDbValues(
  extraction,
  headerRecord = {},
  lineItems = []
) {
  const updatedExtraction = JSON.parse(JSON.stringify(extraction || {}));

  const headerFields = ensureArray(updatedExtraction.headerFields);
  headerFields.forEach((field) => {
    const normalizedName = normalizeLabel(
      field._name || field.name || field.label || ""
    );

    if (
      !normalizedName ||
      FIELDS_TO_SKIP_CORRECTION.includes(normalizedName.toLowerCase())
    ) {
      return;
    }

    if (Object.prototype.hasOwnProperty.call(headerRecord, normalizedName)) {
      updateFieldValueIfDifferent(field, headerRecord[normalizedName]);
    }
  });

  const persistedLineItems = ensureArray(lineItems);

  updatedExtraction.lineItems = ensureArray(updatedExtraction.lineItems).map(
    (group, index) => {
      const itemsGroup = ensureArray(group).map((field) => ({ ...field }));
      const lineItemMatch = persistedLineItems[index];

      if (!lineItemMatch) {
        return itemsGroup;
      }

      itemsGroup.forEach((field) => {
        const normalizedName = normalizeLabel(
          field._name || field.name || field.label || ""
        );

        if (
          !normalizedName ||
          FIELDS_TO_SKIP_CORRECTION.includes(normalizedName.toLowerCase())
        ) {
          return;
        }

        if (Object.prototype.hasOwnProperty.call(lineItemMatch, normalizedName)) {
          updateFieldValueIfDifferent(field, lineItemMatch[normalizedName]);
        }
      });

      return itemsGroup;
    }
  );

  return updatedExtraction;
};

export async function trainModelIfNeeded(options = {}) {
  const { requestData = {}, documentId: documentIdHint } = options;
  const trainModelAI = parseBooleanFlag(requestData.trainModelAI);

  if (!trainModelAI) {
    return null;
  }

  const entities = cds.entities("soautomation") || {};
  const { Documents, DocumentHeaders, DocumentLineItems } = entities;

  if (!Documents || !DocumentHeaders || !DocumentLineItems) {
    return null;
  }

  const db = await cds.connect.to("db");

  let documentId =
    documentIdHint || pickValue(requestData, ["ID", "Id", "id"]);
  let attachmentId =
    requestData.attachmentId ||
    requestData.attachmentID ||
    requestData.body?.attachmentId;

  let instanceId =
    requestData.instanceId ||
    requestData.instanceID ||
    requestData.instanceid;

  let documentRecord = null;

  if (documentId) {
    documentRecord = await db.run(
      SELECT.one.from(Documents).where({ ID: documentId })
    );
  }

  if (!documentRecord && attachmentId) {
    documentRecord = await db.run(
      SELECT.one.from(Documents).where({ attachmentId, instanceId })
    );
  }

  if (documentRecord) {
    documentId = documentRecord.ID;
    attachmentId = attachmentId || documentRecord.attachmentId;
    instanceId = instanceId || documentRecord.instanceId;
  }

  if (!attachmentId || !documentId) {
    return null;
  }

  const doxData = await fetchDoxExtraction(attachmentId);

  if (!doxData || doxData.status === "PENDING" || !doxData.extraction) {
    return null;
  }

  const [headerRecord, lineItemRecords] = await Promise.all([
    db.run(
      SELECT.one.from(DocumentHeaders).where({ documentID_ID: documentId })
    ),
    db.run(SELECT.from(DocumentLineItems).where({ documentID_ID: documentId })),
  ]);

  const updatedExtraction = mergeExtractionWithDbValues(
    doxData.extraction,
    headerRecord || {},
    lineItemRecords || []
  );

  const payload = {
    id: doxData.id || doxData.jobId || attachmentId,
    languageCodes: doxData.languageCodes,
    country: doxData.country,
    extraction: updatedExtraction,
  };

  try {
    const response = await executeHttpRequest(
      { destinationName: "doc_extractor" },
      {
        method: "POST",
        url: `/document/jobs/${attachmentId}`,
        data: payload,
      }
    );
  } catch (err) {
    console.error("Failed to train DOX model", err.message || err);
  }

  console.log("DOX training successful:", {
    status: response?.status,
    data: response?.data,
  });

  return payload;
};

export function normalizeTrackedValue(value) {
  if (value === undefined || value === null) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return String(value);
};

export async function trackFieldChanges(tx, historyEntity, options) {
  if (!historyEntity) return;

  const {
    documentId,
    entityName,
    recordId,
    existingRecord = {},
    updateData = {},
    trackedFields = [],
    userEmail = null,
  } = options;

  const sourceRecordId = recordId ? String(recordId) : null;

  if (!sourceRecordId) {
    return;
  }

  // DocumentHeaderStats gets recreated with a new UUID, so match history by entity+field.
  const reuseAcrossRecordId = entityName === "DocumentHeaderStats";

  for (const field of trackedFields) {
    if (!Object.prototype.hasOwnProperty.call(updateData, field)) {
      continue;
    }

    const previousValue = normalizeTrackedValue(existingRecord[field]);
    const newValue = normalizeTrackedValue(updateData[field]);

    if (previousValue === newValue) {
      continue;
    }

    const lookupWhere = reuseAcrossRecordId
      ? {
          documentID_ID: documentId,
          sourceEntity: entityName,
          fieldName: field,
        }
      : {
          documentID_ID: documentId,
          sourceEntity: entityName,
          sourceRecordId,
          fieldName: field,
        };

    const existingHistory = await tx.run(
      SELECT.one.from(historyEntity).where(lookupWhere)
    );

    if (existingHistory) {
      const updateSet = { currentValue: newValue, userEmail };
      if (reuseAcrossRecordId && existingHistory.sourceRecordId !== sourceRecordId) {
        updateSet.sourceRecordId = sourceRecordId;
      }
      await tx.run(
        UPDATE(historyEntity)
          .set(updateSet)
          .where({ ID: existingHistory.ID })
      );
    } else {
      await tx.run(
        INSERT.into(historyEntity).entries({
          ID: cds.utils.uuid(),
          documentID_ID: documentId,
          sourceEntity: entityName,
          sourceRecordId,
          fieldName: field,
          originalValue: previousValue,
          currentValue: newValue,
          userEmail,
        })
      );
    }
  }
};


const isLineItemProcessed = (item) => {
  if (!item) return false;

  const salesOrder = toStringSafe(item.SalesOrder).trim();
  return item.deleted === true || salesOrder !== "";
};

export async function markDocumentCompletedIfProcessed(tx, documentId, userEmail = null) {
  const { DocumentLineItems, Documents } = cds.entities("soautomation") || {};

  if (!DocumentLineItems || !Documents || !documentId) return;

  const lineItems = await tx.run(
    SELECT.from(DocumentLineItems)
      .columns("deleted", "SalesOrder")
      .where({ documentID_ID: documentId })
  );

  if (!Array.isArray(lineItems) || lineItems.length === 0) return;

  const processedCount = lineItems.filter(isLineItemProcessed).length;
  const allProcessed = processedCount === lineItems.length;
  const hasProcessedItems = processedCount > 0;

  const statusUpdate = allProcessed
    ? "COMPLETED"
    : hasProcessedItems
      ? "PENDING"
      : null;

  if (statusUpdate) {
    await tx.run(
      UPDATE(Documents)
        .set({ status: statusUpdate })
        .where({ ID: documentId })
    );

    if (statusUpdate === "COMPLETED") {
      await stampDocumentCompletion(tx, documentId, userEmail);
    }
  }
};

export function resolveUserEmail(req) {
  return req?.user?.attr?.email ?? req?.user?.id ?? null;
}

export async function stampDocumentCompletion(tx, documentId, userEmail) {
  const { Documents } = cds.entities("soautomation") || {};
  if (!Documents || !documentId) return;
  await tx.run(
    UPDATE(Documents)
      .set({ completedAt: new Date(), completedBy: userEmail || null })
      .where({ ID: documentId, status: "COMPLETED", completedAt: null })
  );
}

export async function stampLineItemCompletion(tx, documentId, userEmail, lineItemIds = null) {
  const { DocumentLineItems } = cds.entities("soautomation") || {};
  if (!DocumentLineItems || !documentId) return;

  // Object-form WHERE: null values generate IS NULL correctly (avoids the CDS xpr-array
  // bug where { val: null } with "is"/"is not" emits `IS $N` instead of `IS NULL`).
  const selectWhere = { documentID_ID: documentId, completedAt: null };
  if (Array.isArray(lineItemIds) && lineItemIds.length > 0) {
    selectWhere.ID = { in: lineItemIds };
  }

  const items = await tx.run(
    SELECT.from(DocumentLineItems).columns("ID", "SalesOrder").where(selectWhere)
  );

  const eligibleIds = items
    .filter(({ SalesOrder }) => SalesOrder != null && SalesOrder !== "")
    .map(({ ID }) => ID);

  if (eligibleIds.length === 0) return;

  await tx.run(
    UPDATE(DocumentLineItems)
      .set({ completedAt: new Date(), completedBy: userEmail || null })
      .where({ ID: { in: eligibleIds } })
  );
}


// export function parseCcRecipients(value){
//   if (value === undefined || value === null) {
//     return null;
//   }

//   if (typeof value === "string") {
//     const trimmed = value.trim();
//     if (!trimmed) return [];

//     try {
//       const parsed = JSON.parse(trimmed);
//       if (Array.isArray(parsed)) {
//         return parsed
//           .map((email) => String(email).trim())
//           .filter(Boolean);
//       }
//     } catch (error) {
//       // Ignore JSON parse errors and treat as single email string
//     }

//     return [trimmed];
//   }

//   if (Array.isArray(value)) {
//     return value.map((email) => String(email).trim()).filter(Boolean);
//   }

//   return [];
// };

export function parseCcRecipients(value) {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map(e => String(e).trim()).filter(Boolean);
      }
    } catch (e) {
      // throw new Error("Error trying to parse CC Recipients emails");
    }
    return trimmed
      .split(/[;,]/)
      .map(email => email.trim())
      .filter(Boolean);
  }

  if (Array.isArray(value)) {
    return value.map(email => String(email).trim()).filter(Boolean);
  }
  return [];
}

/**
 * Retrieve decimal and date formats for a given country using ZSD_SOA_SRV/ CountryFormats.
 * Returns null when the service fails or no data is provided.
 */
export async function getCountryNumberAndDateFormats(countryCode, req, domain, system) {
  const normalizedCode = String(countryCode || "").trim();
  const normalizedDomain = String(domain || "").trim();

  if (!normalizedCode && !normalizedDomain) {
    return null;
  }

  const isPr1System = String(system || "").toUpperCase() === "PR1";

  try {
    const zsdService = await cds.connect.to("ZSD_SOA_SRV");
    adjustZsdServiceForSystem(zsdService, null, system);
    var entity = "CountryFormats"
    let result;
    if (isPr1System) {
      if (!normalizedCode) return null;
      result = await zsdService.tx(req).run(SELECT.from(entity).where({ Country: normalizedCode }));
    } else {
      const filterParts = [];
      if (normalizedCode) filterParts.push(`Country eq '${normalizedCode}'`);
      if (normalizedDomain) filterParts.push(`Domain eq '${normalizedDomain}'`);
      const filter = filterParts.join(" and ");
      const url = `/${entity}?$filter=${encodeURIComponent(filter)}&sap-language=EN`;
      const response = await zsdService.tx(req).get(url);
      result = Array.isArray(response)
        ? response
        : response?.value || response?.d?.results || [];
    }

    if (!Array.isArray(result) || result.length === 0) {
      // console.warn(`No se encontraron formatos para el país: ${normalizedCode}`);
      // req.error(400, `No se encontraron formatos para el país: ${normalizedCode}`);
      return null;
    }
    const firstRecord = result[0];

    const decimalKey = String(firstRecord.DecimalFormat ?? "").trim();
    const dateKey = String(firstRecord.DateFormat ?? "").trim();

    const decimalFormat = decimalKey !== null && decimalKey !== undefined
      ? DECIMAL_FORMAT_MAPPINGS[decimalKey] ?? null
      : null;

    const dateFormat = dateKey
      ? DATE_FORMAT_MAPPINGS[dateKey] || null
      : null;

    if (!decimalFormat && !dateFormat) {
      return null;
    }

    return {
      decimalFormat,
      dateFormat,
    };
  } catch (error) {
    console.error("Failed to fetch country formats", error.message || error);
    return null;
  }
}

/**
 * Retrieve SAP unit of measure for a given ISO UoM using ZSD_SOA_SRV/F4Uoms.
 * Returns null when the service fails or no data is provided.
 */
export async function getSapUomFromIso(isoUom, req, system) {
  const normalizedUom = String(isoUom || "").trim();
  const MAX_RETRIES = 5;

  if (!normalizedUom) {
    return null;
  }

  const fallbackValue = normalizedUom === "KGM" ? "KG" : null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const zsdService = await cds.connect.to("ZSD_SOA_SRV");
      adjustZsdServiceForSystem(zsdService, null, system);
      const entity = "F4Uoms";
      const result = await zsdService
        .tx(req)
        .run(SELECT.from(entity).where({ ISOUom: normalizedUom }));

      if (!Array.isArray(result) || result.length === 0) {
        throw new Error(`No UoM conversion found for ISO UoM: ${normalizedUom}`);
      }

      const firstRecord = result[0] || {};
      const candidates = [
        firstRecord.SAPUom,
        firstRecord.SapUom,
        firstRecord.SAPUOM,
      ];

      const match = candidates.find((value) => {
        const trimmed = String(value ?? "").trim();
        return trimmed.length > 0;
      });

      if (!match) {
        throw new Error(`Empty SAP UoM conversion for ISO UoM: ${normalizedUom}`);
      }

      return String(match).trim();
    } catch (error) {
      const isLastAttempt = attempt === MAX_RETRIES;
      console.error(
        `Failed to fetch UoM conversion (attempt ${attempt + 1}/${MAX_RETRIES + 1})`,
        error.message || error
      );

      if (isLastAttempt) {
        return fallbackValue;
      }
    }
  }

  return fallbackValue;
}

// -- Formatting helpers ----------------------------------------------------

function parseDateValue(value, pattern = null) {
  if (value === undefined || value === null || value === "") return null;

  const buildUtcDate = (year, month, day) => {
    const y = Number(year);
    const m = Number(month);
    const d = Number(day);
    if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;

    const parsedDate = new Date(Date.UTC(y, m - 1, d));
    if (Number.isNaN(parsedDate.getTime())) return null;

    // Guard against impossible dates like 31/02/2026.
    if (
      parsedDate.getUTCFullYear() !== y
      || parsedDate.getUTCMonth() !== m - 1
      || parsedDate.getUTCDate() !== d
    ) {
      return null;
    }

    return parsedDate;
  };

  if (value instanceof Date) {
    return new Date(Date.UTC(
      value.getUTCFullYear(),
      value.getUTCMonth(),
      value.getUTCDate()
    ));
  }

  const str = String(value).trim();
  if (!str) return null;

  if (pattern) {
    const tokenRegex = pattern
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/YYYY|GYY|GY|YY|MM|DD/g, (token) => {
        switch (token) {
          case "YYYY":
          case "GY":
            return "(?<year>\\d{2,4})";
          case "GYY":
          case "YY":
            return "(?<year>\\d{2})";
          case "MM":
            return "(?<month>\\d{2})";
          case "DD":
            return "(?<day>\\d{2})";
          default:
            return token;
        }
      });

    const match = str.match(new RegExp(`^${tokenRegex}$`));
    if (match && match.groups) {
      const { year, month, day } = match.groups;
      const fullYear = year && year.length === 2
        ? Number(year) + 2000
        : Number(year);
      if (fullYear && month && day) {
        const parsedDate = buildUtcDate(fullYear, month, day);
        if (parsedDate) return parsedDate;
      }
    }
  }

  const yyyymmdd = str.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (yyyymmdd) {
    const [, year, month, day] = yyyymmdd;
    return buildUtcDate(year, month, day);
  }

  const isoLike = str.match(/^(\d{4})[-/](\d{2})[-/](\d{2})$/);
  if (isoLike) {
    const [, year, month, day] = isoLike;
    return buildUtcDate(year, month, day);
  }

  const ambiguousShortDate = str.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
  if (ambiguousShortDate) {
    const [, first, second, rawYear] = ambiguousShortDate;
    const year = rawYear.length === 2 ? Number(rawYear) + 2000 : Number(rawYear);

    const patternUpper = String(pattern || "").toUpperCase();
    const ddPosition = patternUpper.indexOf("DD");
    const mmPosition = patternUpper.indexOf("MM");
    const shouldUseDmy = ddPosition !== -1 && mmPosition !== -1
      ? ddPosition < mmPosition
      : Number(first) > 12 || (Number(second) <= 12 && Number(first) <= 12);

    const day = shouldUseDmy ? first : second;
    const month = shouldUseDmy ? second : first;
    const parsedDate = buildUtcDate(year, month, day);
    if (parsedDate) return parsedDate;
  }

  const parsed = new Date(str);
  return Number.isNaN(parsed.getTime())
    ? null
    : new Date(Date.UTC(
      parsed.getUTCFullYear(),
      parsed.getUTCMonth(),
      parsed.getUTCDate()
    ));
}

export function normalizeDecimalValue(value, decimalFormat, { strict = false } = {}) {
  if (value === undefined || value === null || value === "") {
    return strict ? null : value;
  }

  if (typeof value === "number") {
    // return value;
    return Number.isNaN(value) ? (strict ? null : value) : value;
  }

  if (!decimalFormat) {
    const sanitized = sanitizeQuantityValue(value);
    if (sanitized !== null) return sanitized;
    return strict ? null : value;
  }

  const { thousandSeparator, decimalSeparator } = decimalFormat;
  const escapeForRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  let strVal = String(value).trim();

  if (thousandSeparator) {
    strVal = strVal.split(thousandSeparator).join("");
  }

  if (decimalSeparator && decimalSeparator !== ".") {
    const decimalRegex = new RegExp(escapeForRegex(decimalSeparator), "g");
    strVal = strVal.replace(decimalRegex, ".");
  }

  // Remove any characters that are not part of a standard numeric representation
  strVal = strVal.replace(/[^0-9.+-]/g, "");

   if (!/^[+-]?\d*(\.\d+)?$/.test(strVal) || strVal === "" || strVal === "+" || strVal === "-" || strVal === ".") {
    return strict ? null : value;
  }

  const numericValue = Number(strVal);
  return Number.isNaN(numericValue) ? (strict ? null : value) : numericValue;
}

export function formatDecimal(value, decimalFormat) {
  if (!decimalFormat) return value;

  const numericValue = typeof value === "number"
    ? value
    : Number(String(value).replace(/[^0-9.,-]/g, "").replace(/,/g, ""));

  if (!Number.isFinite(numericValue)) {
    return value;
  }

  const [integerPartRaw, decimalPartRaw = ""] = Math.abs(numericValue)
    .toString()
    .split(".");

  const integerPart = integerPartRaw.replace(
    /\B(?=(\d{3})+(?!\d))/g,
    decimalFormat.thousandSeparator
  );

  const sign = numericValue < 0 ? "-" : "";
  const decimalSegment = decimalPartRaw ? `${decimalFormat.decimalSeparator}${decimalPartRaw}` : "";

  return `${sign}${integerPart}${decimalSegment}`;
}

export function formatDate(value, dateFormat) {
  if (!dateFormat?.pattern) return value;

  const date = parseDateValue(value, dateFormat.pattern) || parseDateValue(value);
  if (!date) return value;

  return date.toISOString().slice(0, 10);
}

export function parseComparableDate(value) {
  const normalized = normalizeDate(value);
  if (!normalized) return null;

  let isoDate = null;
  if (/^\d{8}$/.test(normalized)) {
    isoDate = `${normalized.slice(0, 4)}-${normalized.slice(4, 6)}-${normalized.slice(6, 8)}`;
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    isoDate = normalized;
  } else {
    const parsedFromRaw = new Date(String(value));
    if (Number.isNaN(parsedFromRaw.getTime())) return null;
    isoDate = parsedFromRaw.toISOString().slice(0, 10);
  }

  const parsed = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;

  return { normalized, timestamp: parsed.getTime() };
}

export function extractTaskIdFromFilter(filter) {
  const match = filter?.match(/TaskID eq '([^']+)'/i);
  return match ? match[1] : null;
}

export async function deleteTaskId(taskId, externalService, req) {
  if (!taskId) return null;
  try {
    const endpoint = `/TaskIDs('${taskId}')`;
    const result = await externalService.tx(req).delete(endpoint);
    return result;
  } catch (err) {
    console.error(`Error deleting TaskID '${taskId}':`, err.message);
    return null;
  }
}

export function extractResultStatus(result) {
  return toStringSafe(
    result?.TaskStatus ?? result?.taskStatus ??
    result?.Result?.TaskStatus ?? result?.Result?.taskStatus ??
    result?.result?.TaskStatus ?? result?.result?.taskStatus
  ).trim().toUpperCase();
}

export function extractTaskId(result) {
  return toStringSafe(
    result?.TaskID ?? result?.TaskId ?? result?.taskID ?? result?.taskId ??
    result?.Result?.TaskID ?? result?.Result?.TaskId ?? result?.Result?.taskID ?? result?.Result?.taskId ??
    result?.result?.TaskID ?? result?.result?.TaskId ?? result?.result?.taskID ?? result?.result?.taskId
  ).trim();
}