import {
  parseExtractedJSON, normalizeLabel, persistODataDetermineResult,
  sanitizeNumericValue, sanitizeQuantityValue, normalizeDate, ensureArray, fetchDocumentForOData,
  toStringSafe, formatItemNumber, convertUoM, pickValue, extractSalesOrderFromMessage, parseBooleanFlag, fetchDocumentEmails,
  trackFieldChanges, normalizeTrackedValue, fetchDoxExtraction, trainModelIfNeeded, markDocumentCompletedIfProcessed, parseCcRecipients,
  deriveSystemAndCustomer,
  buildODataPayloadFromDb,
  buildPr1ODataPayload,
  adjustZsdServiceForSystem,
  applyHardcodedTestUser,
  enhancePr1SimulatePayload,
  getCountryNumberAndDateFormats,
  getSapUomFromIso,
  normalizeDecimalValue,
  formatAmountValue,
  formatDate,
  DEFAULT_DATE_FORMAT,
  fetchDocumentLogMetadata,
  fetchItemHistoryMap,
  uploadDocumentAttachmentToSharePoint,
  resolveDoxSubdomainUrl,
  truncateRecordStringsByEntity,
  isTimeoutError,
  parseComparableDate,
  extractDomains,
  SPLIT_BY_SALES_ORG_LOGIC,
  groupLineItemsBySalesOrg,
  resolveSplitLogicForRequest,
  splitDocumentBySalesOrg,
  persistanceODataCreateResult,
  extractTaskIdFromFilter,
  deleteTaskId,
  extractResultStatus,
  FIELD_TRACKING_TARGETS,
  resolveUserEmail,
  stampDocumentCompletion,
  stampLineItemCompletion,
  applyDuplicateCreationGuard,
} from './utils.js';

// import { executeHttpRequest } from '@sap-cloud-sdk/http-client';
import cds from '@sap/cds';

const LOG_ID_RETRY_LIMIT = 5;

const isUniqueConstraintError = (error) => {
  const code = error?.code || error?.errno;
  if (code === "SQLITE_CONSTRAINT") return true;
  const message = `${error?.message || ""}`.toLowerCase();
  return message.includes("unique constraint")
    || message.includes("unique constraint failed")
    || message.includes("unique violation")
    || message.includes("duplicate")
    || message.includes("unique index");
};

const getNextLogId = async (runner, Documents) => {
  const { max } =
    (await runner.run(
      SELECT.one.columns`max(LogId) as max`.from(Documents)
    )) || {};
  return (max || 0) + 1;
};

const insertDocumentWithUniqueLogId = async (runner, Documents, baseData) => {
  let lastError;
  for (let attempt = 1; attempt <= LOG_ID_RETRY_LIMIT; attempt += 1) {
    const nextLogId = await getNextLogId(runner, Documents);
    const payload = { ...baseData, LogId: nextLogId };
    try {
      await runner.run(INSERT.into(Documents).entries(payload));
      return { logId: nextLogId, payload };
    } catch (error) {
      lastError = error;
      if (!isUniqueConstraintError(error) || attempt === LOG_ID_RETRY_LIMIT) {
        throw error;
      }
    }
  }
  throw lastError;
};

export default function (srv) {

  srv.before("READ", "UserVariants", req => {
    const userEmail = req.user?.attr?.email;
    const userId = req.user?.id;

    if (userId) {
      req.query.where({ createdBy: userId });
    } else if (userEmail) {
      req.query.where({ email: userEmail });
    }

  });

  srv.before("CREATE", "UserVariants", req => {
    const userEmail = req.user?.attr?.email
    
    if (userEmail) {
      req.data.email = userEmail;   
    }
  });

  srv.on("READ", "Documents", async (req) => {
    try {

      // 1) Detectar la banderita en $search
      const qOpt = req.req?.query || {};
      const search = qOpt.$search;              // OData V4: $search=...

      const filterByUser = search && search.includes('filterByUser:true');
      const filterLast7Days = search && search.includes('last7days:true');
      const filterSubmittedToday = search && search.includes('submittedToday:true');
      const filterOverdue = search && search.includes('overdue:true');
      const filterCompletedToday = search && search.includes('completedToday:true');

      const where = req.query.SELECT.where || [];


      // Usuario autenticado sin roles funcionales → no ve nada
      // Commented for LP1 until they assign roles
      // TODO: Re-enable role-based filtering once roles are assigned in QAS/PRD
      
      // Resolver roles funcionales
      const technicalRoles = ['openid', 'uaa.user'];

      const functionalRoles = req.user?.roles
        ? Object.keys(req.user.roles).filter(r => !technicalRoles.includes(r))
        : [];

      if (req.user && functionalRoles.length === 0) {
        if (where.length > 0 && where[where.length - 1] !== 'and') {
          where.push('and');
        }
        where.push({ val: 1 }, '=', { val: 0 });
        req.query.SELECT.where = where;
        const db = await cds.connect.to('db');
        return await db.run(req.query);
      }
      
      const { RoleEmailMapping } = cds.entities("soautomation");
      const roleEmailMappingRows = functionalRoles.length > 0
        ? await SELECT.from(RoleEmailMapping)
            .columns('email')
            .where({ role: { in: functionalRoles } })
        : [];

      const allowedSenders = [
        ...new Set(
          roleEmailMappingRows
            .map(row => (row.email || '').toLowerCase())
            .filter(Boolean)
        )
      ];

      const addAndOperator = () => {
        if (where.length > 0 && where[where.length - 1] !== 'and') {
          where.push('and');
        }
      };

      const addNonDeletedFilter = () => {
        addAndOperator();
        where.push({ ref: ['deleted'] }, 'is not', { val: true });
      };

      const getDayRange = (daysBack) => {
        const endDate = new Date();
        endDate.setHours(23, 59, 59, 999);

        const startDate = new Date(endDate);
        startDate.setHours(0, 0, 0, 0);
        startDate.setDate(startDate.getDate() - daysBack);

        return { startDate, endDate };
      };

      addNonDeletedFilter();

      if (filterByUser) {
        // 1. Obtener el email del usuario
        const userEmail = req.user?.attr?.email ?? req.user?.id ?? '';
        if (!userEmail) {
          return req.error(400, 'Missing user email for filtering documents');
        }

        // 2. WHERE seguro
        addAndOperator();

        // 3. Agregar condición por usuario
        where.push(
          { func: 'lower', args: [{ ref: ['emailFrom'] }] }, '=', { val: userEmail.toLowerCase() }
        );
      }

      // Commented for LP1 until they assign roles
      // TODO: Re-enable role-based filtering once roles are assigned in QAS/PRD
     
      if (allowedSenders.length > 0) {
        addAndOperator();
        // where.push(
        //   { ref: ['emailSender'] }, 'in', { list: allowedSenders.map(sender => ({ val: sender })) }
        // );
        const emailSenderRef = { func: 'lower', args: [{ ref: ['emailSender'] }] };

        if (allowedSenders.length === 1) {
          where.push(emailSenderRef, '=', { val: allowedSenders[0] });
        } else {
          where.push('(');
          allowedSenders.forEach((sender, index) => {
            if (index > 0) {
              where.push('or');
            }
            where.push(emailSenderRef, '=', { val: sender });
          });
          where.push(')');
        }
       
      }
      if (filterLast7Days) {
        const { startDate, endDate } = getDayRange(7);

        addAndOperator();
        where.push(
          { ref: ['createdAt'] }, '>=', { val: startDate.toISOString() },
          'and',
          { ref: ['createdAt'] }, '<=', { val: endDate.toISOString() }
        );
      }

      if (filterSubmittedToday) {
        const userEmail = req.user?.attr?.email ?? req.user?.id ?? '';
        if (!userEmail) {
          return req.error(400, 'Missing user email for filtering documents');
        }

        const { startDate, endDate } = getDayRange(0);

        addAndOperator();
        where.push(
          { func: 'lower', args: [{ ref: ['emailFrom'] }] }, '=', { val: userEmail.toLowerCase() },
          'and',
          { ref: ['status'] }, '=', { val: 'NEW' },
          'and',
          { ref: ['createdAt'] }, '>=', { val: startDate.toISOString() },
          'and',
          { ref: ['createdAt'] }, '<=', { val: endDate.toISOString() }
        );
      }

      if (filterOverdue) {
        const userEmail = req.user?.attr?.email ?? req.user?.id ?? '';
        if (!userEmail) {
          return req.error(400, 'Missing user email for filtering documents');
        }

        const { startDate, endDate } = getDayRange(1);

        addAndOperator();
        where.push(
          { func: 'lower', args: [{ ref: ['emailFrom'] }] }, '=', { val: userEmail.toLowerCase() },
          'and',
          { ref: ['status'] }, 'in', { list: [{ val: 'PENDING' }, { val: 'NEW' }] },
          'and',
          { ref: ['createdAt'] }, '<', { val: startDate.toISOString() }
        );
      }

      if (filterCompletedToday) {
        const userEmail = req.user?.attr?.email ?? req.user?.id ?? '';
        if (!userEmail) {
          return req.error(400, 'Missing user email for filtering documents');
        }

        const { startDate, endDate } = getDayRange(0);

        addAndOperator();
        where.push(
          { func: 'lower', args: [{ ref: ['emailFrom'] }] }, '=', { val: userEmail.toLowerCase() },
          'and',
          { ref: ['status'] }, '=', { val: 'COMPLETED' },
          'and',
          { ref: ['createdAt'] }, '>=', { val: startDate.toISOString() },
          'and',
          { ref: ['createdAt'] }, '<=', { val: endDate.toISOString() }
        );
      }

      if (filterByUser || filterLast7Days || filterSubmittedToday || filterOverdue || filterCompletedToday) {
        // *** IMPORTANTE: volver a setearlo ***
        req.query.SELECT.where = where;

        // 4. Eliminar search del request HTTP
        delete req.req?.query?.$search;

        // 5. Eliminar search del CQN
        delete req.query?.SELECT?.search;

        // 6. Normalizar si quedó solo ["and"]
        if (
          Array.isArray(req.query.SELECT.where) &&
          req.query.SELECT.where.length === 1 &&
          req.query.SELECT.where[0] === 'and'
        ) {
          req.query.SELECT.where = [];
        }
      }

      // 4) Dejar que CAP ejecute la query normalmente
      const db = await cds.connect.to('db');
      return await db.run(req.query)
    }
    catch (error) {
      req.error(400, "Error getting the Documents: " + error.message);
    }
  })

  srv.on("getDoxExtractedFields", async (req) => {
    try {
      const getField = (fieldName) => req.data[fieldName] ?? req.data.body?.[fieldName];

      const attachmentID = getField("attachmentId");
      if (!attachmentID) {
        req.error(400, "Missing attachmentId in request");
        return;
      }
      if (typeof attachmentID !== "string" || attachmentID.length > 255) {
        req.error(400, "attachmentId must be a string of up to 255 characters");
        return;
      }
      const instanceID = getField("instanceid") || getField("instanceId") || getField("instanceID");
      const isReExtractionFromODataDeterminePR1 = parseBooleanFlag(
        getField("reExtractionFromODataDeterminePR1")
      );

      const skipUpsert = parseBooleanFlag(getField("skipUpsert"));

      const emailSender = getField("emailSender");
      const receivedDatetime = getField("receivedDatetime");
      const subject = getField("subject");
      const emailFrom = getField("emailFrom");
      const ccRecipients = getField("ccRecipients");
      const requestedCustomer = getField("customer");
      const requestedRuleId = getField("ruleId");
      const requestedDomain = getField("domain");
      // const fileName = getField("fileName");

      const { system: derivedSystem, customer: derivedCustomer } =
        await deriveSystemAndCustomer(emailSender, emailFrom);

      if (!instanceID) {
        req.error(400, "Missing mandatory field: instanceid");
        return;
      }

      // let Url = `/document/jobs/${attachmentID}?returnNullValues=false&extractedValues=true&clientId=default`
      // const response = await executeHttpRequest(
      //   { destinationName: "doc_extractor" },
      //   {
      //     method: "GET",
      //     url: Url
      //   }
      // );

      const responseData = await fetchDoxExtraction(attachmentID, {
        extractedValues: !isReExtractionFromODataDeterminePR1,
      });

      

      if (responseData?.status === "PENDING") {
        const pendingPayload = {
          attachmentId: attachmentID,
          emailSender,
          statusDox: responseData?.status,
          receivedDatetime,
          fileName:responseData?.fileName,
          subject,
          instanceId: instanceID,
          schemaName: responseData?.schemaName,
          schemaVersion: responseData?.schemaVersion,
          status: "NEW",
          emailFrom,
          ccRecipients
        };

        if (derivedSystem) {
          pendingPayload.system = derivedSystem;
        }

        if (derivedCustomer) {
          pendingPayload.customer = derivedCustomer;
        }

        if (requestedDomain !== undefined && requestedDomain !== null && String(requestedDomain).trim()) {
          pendingPayload.domain = String(requestedDomain).trim();
        }

        const pendingBodyString = JSON.stringify(pendingPayload);

        let logId = null;

        if (!skipUpsert) {
          const upsertResult = await srv.send("upsertDocument", { body: pendingBodyString });
          logId = upsertResult?.logId ?? null;
        }

        return {
          message: "Document saved with pending DOX status",
          status: responseData?.status,
          hasExtraction: false,
          logId,
          logsId: [],
        };
      }

      const finalPayload = {
        attachmentId: attachmentID,
        emailSender,
        statusDox: responseData?.status,
        receivedDatetime,
        fileName:responseData?.fileName,
        subject,
        schemaName: responseData?.schemaName,
        schemaVersion: responseData?.schemaVersion,
        status: "NEW",
        emailFrom,
        ccRecipients,
        instanceId: instanceID,
        extraction: responseData?.extraction,
      };

      if (derivedSystem) {
        finalPayload.system = derivedSystem;
      }

      if (derivedCustomer) {
        finalPayload.customer = derivedCustomer;
      }

      if (requestedCustomer !== undefined && requestedCustomer !== null && String(requestedCustomer).trim()) {
        finalPayload.customer = String(requestedCustomer).trim();
      }

      if (requestedDomain !== undefined && requestedDomain !== null && String(requestedDomain).trim()) {
        finalPayload.domain = String(requestedDomain).trim();
      }

      const bodyString = JSON.stringify(finalPayload);

      let logId = null;
      let logsId = [];

      if (!skipUpsert) {
        const payloadSystem = String(finalPayload.system || "").toUpperCase();
        const isPr1 = payloadSystem === "PR1";
        const splitLogic = isPr1
          ? await resolveSplitLogicForRequest(requestedCustomer, requestedRuleId)
          : null;
        const shouldSplit = splitLogic === SPLIT_BY_SALES_ORG_LOGIC;

        if (shouldSplit) {
          try {
            const { Documents } = cds.entities("soautomation");
            const splitCandidates = ensureArray(finalPayload?.extraction?.lineItems);
            const splitInfo = groupLineItemsBySalesOrg(splitCandidates);
            const existingPendingDocument = await SELECT.one
              .from(Documents)
              .where({
                attachmentId: attachmentID,
                instanceId: instanceID,
                statusDox: "PENDING",
              })
              .columns("ID");
            const reuseFirstDocument = Boolean(existingPendingDocument);

            if (splitInfo.hasValidSalesOrg && splitInfo.groups.length > 0) {
              logsId = await splitDocumentBySalesOrg({
                srv,
                basePayload: finalPayload,
                groupedLineItems: splitInfo.groups,
                reuseFirstDocument,
              });
              logId = logsId[0] ?? null;
            } else {
              const upsertResult = await srv.send("upsertDocument", { body: bodyString });
              logId = upsertResult?.logId ?? null;
            }
          } catch (splitError) {
            console.error("Error splitting document by salesOrg, falling back to single upsert:", splitError);
            const upsertResult = await srv.send("upsertDocument", { body: bodyString });
            logId = upsertResult?.logId ?? null;
            logsId = [];
          }
        } else {
          const upsertResult = await srv.send("upsertDocument", { body: bodyString });
          logId = upsertResult?.logId ?? null;
        }
      }

      return {
        message: "Document updated/created with extraction",
        status: responseData?.status,
        hasExtraction: responseData?.extraction ? true : false,
        logId,
        logsId,
      };
    } catch (error) {
      req.error(400, "Error Getting Dox Extracted Fields | " + error.message);
    }
  });


  srv.on("determineTemplate", async (req) => {
    try {
      const { context } = req.data;
      const normalizeText = (value) => String(value || "").toLowerCase();
      const normalizeSchemaName = (value) =>
        value === null || value === undefined ? null : String(value).trim();

      const emailTo = normalizeText(context?.to);
      const html = normalizeText(context?.body);
      const subject = normalizeText(context?.subject);
      const fileName = normalizeText(context?.fileName);

      const db = await cds.connect.to('db');

      const { EmailMapping, CustomerConfig } = cds.entities('soautomation');

      const emailMap = await db.run(
        SELECT.one.from(EmailMapping)
          .where`lower(email) = ${emailTo.toLowerCase()}`
      );

      const systemValue = emailMap ? emailMap.system : null;
      const domains = extractDomains(html);

      const parseKeywords = (value) =>
        String(value || "")
          .split(";")
          .map((entry) => normalizeText(entry).trim())
          .filter(Boolean);

      const evaluateRule = (rule) => {
        const subjectKeywords = parseKeywords(rule.subjectKeywords);
        const bodyKeywords = parseKeywords(rule.bodyKeywords);
        const fileNameKeywords = parseKeywords(rule.fileNameKeywords);
        const checks = [];

        if (subjectKeywords.length > 0) {
          checks.push(subjectKeywords.some((keyword) => subject.includes(keyword)));
        }
        if (bodyKeywords.length > 0) {
          checks.push(bodyKeywords.some((keyword) => html.includes(keyword)));
        }
        if (fileNameKeywords.length > 0) {
          checks.push(fileNameKeywords.some((keyword) => fileName.includes(keyword)));
        }

        // Skip rules that do not define any keyword criteria.
        if (checks.length === 0) return false;

        // Every non-empty keyword group must match (AND),
        // while each group still supports "keyword1;keyword2" as OR semantics.
        return checks.every(Boolean);
      };

      const resolveByCustomerKey = async (customerKey) => {
        if (!customerKey) return null;

        const whereClause = { xpr: [{ func: "lower", args: [{ ref: ["customer"] }] }, "=", { val: customerKey.toLowerCase() }] };
        const parentFilter = CustomerConfig?.elements?.active ? [{ ref: ["active"] }, "=", { val: true }, "and", ...whereClause.xpr] : whereClause;

        const configs = await db.run(
          SELECT.from(CustomerConfig)
            .where(parentFilter)
            .columns(
              "customer",
              "schemaName",
              "version",
              "template",
              {
                ref: ["rules"],
                expand: [
                  { ref: ["ID"] },
                  { ref: ["schemaName"] },
                  { ref: ["version"] },
                  { ref: ["template"] },
                  { ref: ["subjectKeywords"] },
                  { ref: ["bodyKeywords"] },
                  { ref: ["fileNameKeywords"] },
                  { ref: ["priority"] },
                  { ref: ["active"] },
                  { ref: ["logic"] },
                ],
              }
            )
        );

        const matches = [];
        for (const config of configs || []) {
          const activeRules = (config.rules || []).filter((rule) => rule.active !== false);
          if (activeRules.length === 0) continue;

          for (const rule of activeRules) {
            if (!evaluateRule(rule)) continue;
            matches.push({
              customer: config.customer,
              schemaName: normalizeSchemaName(rule.schemaName ?? config.schemaName),
              version: rule.version ?? config.version,
              template: rule.template ?? config.template,
              ruleId: rule.ID ?? null,
              priority: Number.isFinite(rule.priority) ? rule.priority : 100,
            });
          }
        }

        if (matches.length === 0) return null;
        matches.sort((a, b) => a.priority - b.priority);
        return matches[0];
      };

      const findByDomainRules = async () => {
        for (const domain of domains) {
          const match = await resolveByCustomerKey(domain);
          if (match) return match;
        }
        return null;
      };

      const applyLegacyFallback = async () => {
        let legacyConfig = null;
        let legacyCustomer = null;

        for (const domain of domains) {
          legacyConfig = await db.run(
            SELECT.one.from(CustomerConfig).where`lower(customer) = ${domain}`
          );
          if (legacyConfig) {
            legacyCustomer = legacyConfig.customer || domain;
            break;
          }
        }

        if (!legacyConfig && emailTo) {
          legacyConfig = await db.run(
            SELECT.one.from(CustomerConfig).where`lower(customer) = ${emailTo}`
          );
          if (legacyConfig) {
            legacyCustomer = legacyConfig.customer || emailTo;
          }
        }

        if (!legacyConfig && systemValue) {
          legacyConfig = await db.run(
            SELECT.one.from(CustomerConfig).where`lower(customer) = ${String(systemValue).toLowerCase()}`
          );
          if (legacyConfig) {
            legacyCustomer = legacyConfig.customer || systemValue;
          }
        }

        return {
          customer: legacyCustomer || systemValue || null,
          schemaName: legacyConfig ? normalizeSchemaName(legacyConfig.schemaName) : null,
          version: legacyConfig ? legacyConfig.version : 0,
          template: legacyConfig ? legacyConfig.template : false,
          ruleId: null,
          system: systemValue || null,
          domain: (domains[0] || "").replace(/^@/, "")
        };
      };

      let resolved = await findByDomainRules();

      if (!resolved) {
        resolved = await resolveByCustomerKey(emailTo);
      }

      if (!resolved) {
        resolved = await resolveByCustomerKey(systemValue);
      }

      if (!resolved) {
        return await applyLegacyFallback();
      }

      return {
        customer: resolved.customer || systemValue || null,
        schemaName: normalizeSchemaName(resolved.schemaName),
        version: resolved.version ?? 0,
        template: resolved.template ?? false,
        ruleId: resolved.ruleId ?? null,
        system: systemValue || null,
        domain: (domains[0] || "").replace(/^@/, "")
      };

    } catch (err) {
      // console.error("Error in determineTemplate:", err);
      req.error(400, "Error determining template | " + err.message);
    }
  });

  srv.on("formatExtractedFields", async (req) => {
    try {
      const raw = req.data.body;
      const parsed = parseExtractedJSON(raw);
      const headers = parsed.extraction?.headerFields || [];

      const getValue = (name) => {
        const field =
          headers.find(
            (f) => f._name === name || f.name === name || f.label === name
          ) || {};
        return field.value ?? "";
      };

      const result = {
        documentNumber: getValue("documentNumber"),
        taxId: getValue("taxId"),
        netAmount: getValue("netAmount"),
        grossAmount: getValue("grossAmount"),
        currencyCode: getValue("currencyCode"),
        documentDate: getValue("documentDate"),
        deliveryDate: getValue("deliveryDate"),
        paymentTerms: getValue("paymentTerms"),
        senderBankAccount: getValue("senderBankAccount"),
        senderAddress: getValue("senderAddress"),
        senderName: getValue("senderName"),
        shipToAddress: getValue("shipToAddress"),
        taxIdNumber: getValue("taxIdNumber"),
        receiverId: getValue("receiverId"),
        shippingTerms: getValue("shippingTerms"),
        quantity: getValue("quantity"),
        senderId: getValue("senderId"),
        senderStreet: getValue("senderStreet"),
        senderCity: getValue("senderCity"),
        senderHouseNumber: getValue("senderHouseNumber"),
        senderPostalCode: getValue("senderPostalCode"),
        senderCountryCode: getValue("senderCountryCode"),
        vendorCountryCode: getValue("vendorCountryCode"),
        senderPhone: getValue("senderPhone"),
        senderFax: getValue("senderFax"),
        senderEmail: getValue("senderEmail"),
        senderState: getValue("senderState"),
        senderDistrict: getValue("senderDistrict"),
        senderExtraAddressPart: getValue("senderExtraAddressPart"),
        shipToName: getValue("shipToName"),
        shipToStreet: getValue("shipToStreet"),
        shipToCity: getValue("shipToCity"),
        shipToHouseNumber: getValue("shipToHouseNumber"),
        shipToPostalCode: getValue("shipToPostalCode"),
        shipToCountryCode: getValue("shipToCountryCode"),
        shipToPhone: getValue("shipToPhone"),
        shipToFax: getValue("shipToFax"),
        shipToEmail: getValue("shipToEmail"),
        shipToState: getValue("shipToState"),
        shipToDistrict: getValue("shipToDistrict"),
        shipToExtraAddressPart: getValue("shipToExtraAddressPart"),
        shipToId: getValue("shipToId"),
        internal: getValue("internal"),
        Nav_LineItem: [],
        Nav_HeaderStat: [{}],
        Nav_ItemStat: [{}],
        Nav_ShipTo: [{}],
        Nav_SoldTo: [{}],
      };

      const lineItems = parsed.extraction?.lineItems || [];
      let counter = 1;

      for (const item of lineItems) {
        const map = {};
        for (const f of item) map[f.name] = f.value ?? "";

        result.Nav_LineItem.push({
          documentNumber: result.documentNumber || "",
          itemNumber: map.itemNumber || String(counter).padStart(3, "0"),
          description: map.description || "",
          netAmount: map.netAmount || "",
          quantity: map.quantity || "",
          unitPrice: map.unitPrice || "",
          documentDate: result.documentDate || "",
          currencyCode: map.currencyCode || result.currencyCode || "",
          supplierMaterialNumber: map.supplierMaterialNumber || "",
          customerMaterialNumber: map.customerMaterialNumber || "",
          unitOfMeasure: map.unitOfMeasure || "",
        });
        counter++;
      }

      return result;
    } catch (error) {
      // console.error("Error formatting extracted fields:", error);
      return JSON.stringify({ error: error.message });
    }
  });

  srv.on("determineCustomer", async (req) => {
    try {
      const html = req.data?.body ?? "";
      return extractDomains(html);
    } catch (error) {
      req.error(400, "Error determining customer | " + error.message);
    }
  });

  srv.on("upsertDocument", async (req) => {
      console.log('🔥 upsertDocument CALLED');
    try {
      return await cds.tx(async () => {
        // Ejecutamos el upsert en una transacción CAP independiente para que
        // un rollback aquí no deje abortada la transacción del request llamador.
        const raw = req.data.body;
      // const parsed = parseExtractedJSON(raw);
      // const payload = parsed.body || parsed;
      let payload = null;
      if (typeof raw === "string") {
        const parsed = parseExtractedJSON(raw);
        payload = parsed.body || parsed;
      } else {
        payload = raw?.body || raw;
      }

      if (!payload) {
        return req.reject(400, "Missing body in request");
      }
      const attachmentId = payload.attachmentid || payload.attachmentId;
      if (!attachmentId) {
        return req.reject(400, "Missing mandatory field: attachmentid or attachmentId");
      }

      if (!payload.extraction) {
        const doxResponse = await fetchDoxExtraction(attachmentId);
        if (doxResponse?.extraction) {
          payload.extraction = doxResponse.extraction;
        }
        if (!payload.statusDox && doxResponse?.status) {
          payload.statusDox = doxResponse.status;
        }
      }

      const db = await cds.connect.to("db");
      const tx = db;

      const {
        Documents,
        DocumentHeaders,
        DocumentLineItems,
        DocumentCCRecipients,
        DocumentAttachments,
      } = cds.entities("soautomation");
      payload.attachmentid = attachmentId;
      payload.attachmentId = attachmentId;
      const forceInsert = parseBooleanFlag(payload.forceInsert) || parseBooleanFlag(payload.forceNewDocument);

      let existing = null;

      if (!forceInsert && payload.instanceId) {
        const where = { instanceId: payload.instanceId };
        if (attachmentId) {
          where.attachmentId = attachmentId;
        }
        existing = await tx.run(SELECT.one.from(Documents).where(where));
      }

      if (!forceInsert && !existing && attachmentId) {
        existing = await tx.run(
          SELECT.one.from(Documents).where({ attachmentId })
        );
      }

      const docFields = [
        "attachmentid", "emailSender", "receivedDatetime", "fileName",
        "subject", "status", "statusDox", "instanceId",
        "customer", "schemaName", "schemaVersion", "emailFrom", "system",
        "splitParentLogId", "splitIsParent"
      ];

      const documentData = {};
      for (const f of docFields) {
        if (payload[f] !== undefined && payload[f] !== null) {
          const dbField = f === "attachmentid" ? "attachmentId" : f;
          documentData[dbField] = payload[f];
        }
      }

      let documentId;
      if (existing) {
        if (Object.keys(documentData).length > 0) {
          await tx.run(UPDATE(Documents).set(documentData).where({ ID: existing.ID }));
        }
        documentId = existing.ID;
      } else {
        const { system: derivedSystem, customer: derivedCustomer } =
          await deriveSystemAndCustomer(payload.emailSender, payload.emailFrom);

        if (derivedSystem && documentData.system === undefined) {
          documentData.system = derivedSystem;
        }

        if (derivedCustomer && documentData.customer === undefined) {
          documentData.customer = derivedCustomer;
        }

        documentId = cds.utils.uuid();
        documentData.ID = documentId;
        const { logId } = await insertDocumentWithUniqueLogId(tx, Documents, documentData);
        documentData.LogId = logId;
      }

      const logId = existing?.LogId || documentData.LogId;
      const parsedCcRecipients = parseCcRecipients(payload.ccRecipients);

      if (parsedCcRecipients !== null && documentId) {
        await tx.run(
          DELETE.from(DocumentCCRecipients).where({ documentID_ID: documentId })
        );

        if (parsedCcRecipients.length > 0) {
          const entries = parsedCcRecipients.map((email) => ({
            ID: cds.utils.uuid(),
            documentID_ID: documentId,
            email,
          }));

          await tx.run(INSERT.into(DocumentCCRecipients).entries(entries));
        }
      }

      const originalFileName =
        payload.fileName || payload.FileName || existing?.fileName || documentData.fileName;
      const environment =
        payload.environment || payload.Environment || payload.env || payload.ENV || null;
      const requestUrl =
        req?.req?.headers?.referer ||
        req?.req?.headers?.origin ||
        req?.req?.headers?.host;

      let hasExistingAttachment = false;

      if (DocumentAttachments && documentId && attachmentId) {
        const existingAttachment = await tx.run(
          SELECT.one.from(DocumentAttachments).where({
            documentID_ID: documentId,
            attachmentId,
          })
        );

        hasExistingAttachment = Boolean(existingAttachment);
      }

      if (!hasExistingAttachment) {
        void uploadDocumentAttachmentToSharePoint({
          attachmentId,
          logId,
          originalFileName,
          environment,
          requestUrl,
          documentId,
        });
      }

      if (payload.extraction && ["DONE", "CONFIRMED"].includes(payload.statusDox)) {
        const { headerFields = [], lineItems = [] } = payload.extraction;
        const documentSystem = (existing?.system || documentData?.system || "").toUpperCase();
        const isPr1System = documentSystem === "PR1";
        const headerFormattingTargets = {
          decimals: ["netAmount", "grossAmount", "quantity"],
          dates: ["deliveryDate"],
        };
        const lineItemFormattingTargets = {
          decimals: ["netAmount", "unitPrice", "quantity"],
          dates: ["documentDate"],
        };
        const pr1HeaderDecimalFieldsAsIs = ["netAmount", "grossAmount", "quantity"];
        const pr1LineItemDecimalFieldsAsIs = ["netAmount", "unitPrice", "quantity"];

        const applyFieldFormatting = (record, fieldsConfig, formats) => {
          if (!record || !formats) return;

          const { decimalFormat, dateFormat } = formats;

          (fieldsConfig.decimals || []).forEach((fieldName) => {
            if (Object.prototype.hasOwnProperty.call(record, fieldName)) {
              const normalized = normalizeDecimalValue(record[fieldName], decimalFormat);
              record[fieldName] = normalized;
            }
          });

          (fieldsConfig.dates || []).forEach((fieldName) => {
            if (Object.prototype.hasOwnProperty.call(record, fieldName)) {
              const formatted = formatDate(record[fieldName], dateFormat);
              record[fieldName] = formatted;
            }
          });
        };

        // 1 Llamar al servicio  /CountryFormats?$filter=Country eq 'IN'&sap-client=400&sap-language=EN
        // Guardar el formato de fecha y de amount/quantity
        let countryFormats = null;

        const senderCountryField = (headerFields || []).find((field) => {
          const rawKey = field.label || field.name || field._name;
          return normalizeLabel(rawKey) === "senderCountryCode";
        });

        const senderCountryCode = senderCountryField?.value || senderCountryField?.text;
        const requestedDomain = payload.domain;

        if (senderCountryCode || requestedDomain) {
          countryFormats = await getCountryNumberAndDateFormats(
            senderCountryCode,
            req,
            requestedDomain,
            documentSystem
          );
        }
        const effectiveFormats = {
          decimalFormat: countryFormats?.decimalFormat ?? null,
          dateFormat: countryFormats?.dateFormat ?? DEFAULT_DATE_FORMAT,
        };
        const uomConversionCache = new Map();
        let firstLineItemDocumentDate = null;
        let pr1ClosestLineItemDocumentDate = null;
        let hasAnyPr1LineItemDocumentDate = false;
        if (Array.isArray(lineItems)) {
          const pr1LineItemDocumentDates = [];
          for (const itemArr of lineItems) {
            if (!Array.isArray(itemArr)) continue;
            let itemDeliveryDateCandidate = null;
            let itemDocumentDateCandidate = null;

            for (const field of itemArr) {
              const rawKey = field.label || field.name || field._name;
              if (!rawKey) continue;
              const name = normalizeLabel(rawKey);
              if (name !== "documentDate" && name !== "itemDeliveryDate") continue;
              const value = field.value ?? null;

              if (!value) continue;

              if (!isPr1System && name === "itemDeliveryDate" && !itemDeliveryDateCandidate) {
                itemDeliveryDateCandidate = sanitizeNumericValue(value);
              }

              if (!isPr1System && name === "documentDate" && !itemDocumentDateCandidate) {
                itemDocumentDateCandidate = sanitizeNumericValue(value);
              }

              if (name === "documentDate" && isPr1System) {
                const normalizedPr1DocumentDate = sanitizeNumericValue(value);
                if (normalizedPr1DocumentDate) {
                  pr1LineItemDocumentDates.push(normalizedPr1DocumentDate);
                }
              }
            }

            if (!isPr1System) {
              const preferredItemDate = itemDeliveryDateCandidate || itemDocumentDateCandidate;
              if (preferredItemDate) {
                firstLineItemDocumentDate = preferredItemDate;
                break;
              }
            }
          }

          if (isPr1System && pr1LineItemDocumentDates.length > 0) {
            hasAnyPr1LineItemDocumentDate = true;
            const todayUtc = new Date();
            todayUtc.setUTCHours(0, 0, 0, 0);
            const todayTs = todayUtc.getTime();
            let closestDate = null;
            let closestDistance = Number.POSITIVE_INFINITY;

            for (const candidate of pr1LineItemDocumentDates) {
              const parsedCandidate = parseComparableDate(candidate);
              if (!parsedCandidate) continue;
              const distance = Math.abs(parsedCandidate.timestamp - todayTs);
              if (distance < closestDistance) {
                closestDistance = distance;
                closestDate = parsedCandidate.normalized;
              }
            }

            pr1ClosestLineItemDocumentDate = closestDate;
          }
        }


        let headerDeliveryDate = null;
        if (Array.isArray(headerFields) && headerFields.length > 0) {
          const headerMap = {};
          let pr1ExtractedDocumentDate = null;
          let pr1DocumentDateFieldSeen = false;
          for (const field of headerFields) {
            const rawKey = field.label || field.name || field._name;
            if (!rawKey) continue;

            // const name = normalizeLabel(rawKey);
            const normalizedName = normalizeLabel(rawKey);
            const replacements = {
                shipToID: "shipToId",
                senderPOBox: "senderPoBox",
                shipToPOBox: "shipToPoBox"
            }
            let name = replacements[normalizedName] || normalizedName
            if (!name) continue;

            const value = field.value ?? null;

            if (isPr1System && name === "documentDate") {
              pr1DocumentDateFieldSeen = true;
              if (value !== null && value !== "") {
                pr1ExtractedDocumentDate = sanitizeNumericValue(value);
                headerMap.sentDate = pr1ExtractedDocumentDate
              }
            }

              if (value !== null) {
                if (name.toLowerCase().includes("amount")) {
                  const decimalFieldName = name === "grossAmount" ? "grossAmount" : "netAmount";
                  const shouldKeepAsIs =
                    isPr1System && pr1HeaderDecimalFieldsAsIs.includes(decimalFieldName);
                  headerMap[decimalFieldName] = shouldKeepAsIs
                    ? normalizeDecimalValue(value, null, { strict: true })
                    : normalizeDecimalValue(
                      value,
                      effectiveFormats?.decimalFormat,
                      { strict: true }
                    );
              }
              else if (name.toLowerCase().includes("quantity")) {
                const decimalFieldName = "quantity";
                const shouldKeepAsIs =
                  isPr1System &&
                  name === decimalFieldName &&
                  pr1HeaderDecimalFieldsAsIs.includes(decimalFieldName);
                headerMap.quantity = shouldKeepAsIs
                  ? normalizeDecimalValue(value, null, { strict: true })
                  : normalizeDecimalValue(
                    value,
                    effectiveFormats?.decimalFormat,
                    { strict: true }
                  );
              }
              else if (name === "documentNumber") {
                headerMap[name] = toStringSafe(value);
              }
              else if (name === "salesOrg" || name === "dtmSalesOrg") {
                // SalesOrg is an identifier; keep it as string to preserve leading zeros (e.g. "0353").
                headerMap[name] = toStringSafe(value).trim();
              }
              else if (name === "shipToPostalCode" || name === "senderPostalCode") {
                // Postal codes are identifiers; keep as string to preserve leading zeros (e.g. "07300").
                headerMap[name] = toStringSafe(value).trim();
              }
              else {

                // headerMap[name] = sanitizeNumericValue(value);
                // headerMap[name] = value
                headerMap[name] = sanitizeNumericValue(value);

              }
            }
          }

          if (isPr1System) {
            // Para PR1, documentDate debe venir exclusivamente del campo extraído "documentDate".
            // Si no viene o viene vacío, se fuerza a null para evitar cualquier fallback implícito.
            headerMap.documentDate =
              pr1DocumentDateFieldSeen && pr1ExtractedDocumentDate
                ? pr1ExtractedDocumentDate
                : null;
          }

          if (isPr1System) {
            delete headerMap.shipToPoBox
            delete headerMap.senderPoBox
          }
            
          if (headerMap?.senderCountryCode){
            headerMap.extractedSenderCountryCode = headerMap.senderCountryCode
          }
          
          if (!isPr1System) {
            const extractedHeaderDocumentDate = headerMap?.documentDate;
            const normalizedCustomerRefDate =
              extractedHeaderDocumentDate !== undefined &&
                extractedHeaderDocumentDate !== null &&
                extractedHeaderDocumentDate !== ""
                ? sanitizeNumericValue(extractedHeaderDocumentDate)
                : null;
            headerMap.customerRefDate = normalizedCustomerRefDate
          }


          // if (!isPr1System && !headerMap.deliveryDate && firstLineItemDocumentDate) {
          //   headerMap.deliveryDate = firstLineItemDocumentDate;
          // } 

          if (!isPr1System) {
            if (!headerMap.deliveryDate && firstLineItemDocumentDate) {
              headerMap.deliveryDate = firstLineItemDocumentDate;
            }
          } else {
            headerMap.deliveryDate = headerMap.deliveryDate ? headerMap.deliveryDate : pr1ClosestLineItemDocumentDate || null
          }

          headerDeliveryDate = headerMap.deliveryDate || null;

          const effectiveHeaderFormattingTargets = isPr1System
            ? {
              ...headerFormattingTargets,
              decimals: (headerFormattingTargets.decimals || []).filter(
                (fieldName) => !pr1HeaderDecimalFieldsAsIs.includes(fieldName)
              ),
            }
            : headerFormattingTargets;
          applyFieldFormatting(headerMap, effectiveHeaderFormattingTargets, effectiveFormats);
          truncateRecordStringsByEntity(headerMap, DocumentHeaders);

          const existingHeader = await tx.run(
            SELECT.one.from(DocumentHeaders).where({ documentID_ID: documentId })
          );

          if (existingHeader) {
            if (Object.keys(headerMap).length > 0) {
              await tx.run(UPDATE(DocumentHeaders).set(headerMap).where({ ID: existingHeader.ID }));
            }
          } else {
            if (Object.keys(headerMap).length > 0) {
              if (!headerMap.sentDate) {
                headerMap.sentDate = new Date().toISOString().slice(0, 10);
              }
              headerMap.ID = cds.utils.uuid();
              headerMap.documentID_ID = documentId;
              await tx.run(INSERT.into(DocumentHeaders).entries(headerMap));
            }
          }
        }



        const effectiveDeliveryDateRaw = headerDeliveryDate || firstLineItemDocumentDate || null;
        const effectiveDeliveryDate = effectiveDeliveryDateRaw
          ? formatDate(
            effectiveDeliveryDateRaw,
            effectiveFormats?.dateFormat ?? DEFAULT_DATE_FORMAT
          )
          : null;

        if (Array.isArray(lineItems) && lineItems.some(arr => Array.isArray(arr) && arr.length > 0)) {
          let itemIndex = 0; // contador para generar itemNumber
          for (const itemArr of lineItems) {
            if (!Array.isArray(itemArr) || itemArr.length === 0) continue;

            const itemMap = {};
            const hasValue = (value) =>
              !(value === undefined ||
                value === null ||
                (typeof value === "string" && value.trim() === ""));
            let materialNumberValue;
            let supplierMaterialNumberValue;
            let customerMaterialNumberValue;
            let senderMaterialNumberValue;
            let extractedItemNumberValue;
            let documentDateValue = null;
            let itemDeliveryDateValue = null;

            for (const f of itemArr) {
              const rawKey = f.label || f.name || f._name;
              if (!rawKey) continue;

              const name = normalizeLabel(rawKey);
              if (!name) continue;

              const value = f.value ?? null;

              if (name === "itemNumber") {
                const extractedItemNumber = hasValue(value) ? value : f.rawValue;
                if (hasValue(extractedItemNumber)) {
                  extractedItemNumberValue = extractedItemNumber;
                }
                continue;
              }

              if (name === "unitOfMeasure") {
                const LP1UomMappings = {
                  KGM: "KG",
                };
                let uomValue
                if (isPr1System) {
                  uomValue = hasValue(value) ? value : "";
                } else {
                  uomValue = f.rawValue;
                }
                const rawUom = String(uomValue ?? "").trim();
                if (rawUom) {
                  // let convertedUom = uomConversionCache.get(rawUom);
                  // if (convertedUom === undefined) {
                  //   convertedUom = await getSapUomFromIso(rawUom, req);
                  //   uomConversionCache.set(rawUom, convertedUom || rawUom);

                  if (isPr1System) {
                    let convertedUom = uomConversionCache.get(rawUom);
                    if (convertedUom === undefined) {
                      convertedUom = await getSapUomFromIso(rawUom, req, documentSystem);
                      uomConversionCache.set(rawUom, convertedUom || rawUom);
                    }
                    itemMap.unitOfMeasure = convertedUom || rawUom;
                  } else {
                    // itemMap.unitOfMeasure = rawUom;
                    itemMap.unitOfMeasure = LP1UomMappings[rawUom] || rawUom;
                  }
                  // itemMap.unitOfMeasure = convertedUom || rawUom;
                }
                continue;
              }

              if (value !== null) {
                if (name === "materialNumber") {
                  if (hasValue(value)) {
                    materialNumberValue = value;
                  }
                  continue;
                }
                if (name === "supplierMaterialNumber") {
                  if (hasValue(value)) {
                    supplierMaterialNumberValue = value;
                  }
                  continue;
                }
                if (name === "customerMaterialNumber") {
                  if (hasValue(value)) {
                    customerMaterialNumberValue = value;
                  }
                  continue;
                }
                if (name === "senderMaterialNumber") {
                  if (hasValue(value)) {
                    senderMaterialNumberValue = value;
                  }
                  continue;
                }
                if (name === "itemDeliveryDate") {
                  itemDeliveryDateValue = sanitizeNumericValue(value);
                  continue;
                }
                if (name === "documentDate") {
                  documentDateValue = sanitizeNumericValue(value);
                  continue;
                }
                if (name === "quantity" || name.toLowerCase().includes("quantity")) {
                  const decimalFieldName = "quantity";
                  const shouldKeepAsIs =
                    isPr1System &&
                    name === decimalFieldName &&
                    pr1LineItemDecimalFieldsAsIs.includes(decimalFieldName);
                  itemMap.quantity = shouldKeepAsIs
                    ? normalizeDecimalValue(value, null, { strict: true })
                    : normalizeDecimalValue(
                      value,
                      effectiveFormats?.decimalFormat,
                      { strict: true }
                    );
                } else if (name.toLowerCase().includes("amount")) {
                  const decimalFieldName = "netAmount";
                  const shouldKeepAsIs =
                    isPr1System && pr1LineItemDecimalFieldsAsIs.includes(decimalFieldName);
                  itemMap.netAmount = shouldKeepAsIs
                    ? normalizeDecimalValue(value, null, { strict: true })
                    : normalizeDecimalValue(
                      value,
                      effectiveFormats?.decimalFormat,
                      { strict: true }
                    );
                } else if (name.toLowerCase().includes("unitprice")) {
                  const decimalFieldName = "unitPrice";
                  const shouldKeepAsIs =
                    isPr1System && pr1LineItemDecimalFieldsAsIs.includes(decimalFieldName);
                  itemMap.unitPrice = shouldKeepAsIs
                    ? normalizeDecimalValue(value, null, { strict: true })
                    : normalizeDecimalValue(
                      value,
                      effectiveFormats?.decimalFormat,
                      { strict: true }
                    );
                } else {
                  itemMap[name] = value;
                }
              }
            }

            if (hasValue(materialNumberValue)) {
              itemMap.supplierMaterialNumber = materialNumberValue;
            } else if (hasValue(supplierMaterialNumberValue)) {
              itemMap.supplierMaterialNumber = supplierMaterialNumberValue;
            }

            if (hasValue(customerMaterialNumberValue)) {
              itemMap.customerMaterialNumber = customerMaterialNumberValue;
            } else if (hasValue(senderMaterialNumberValue)) {
              itemMap.customerMaterialNumber = senderMaterialNumberValue;
            }

            if (
              isPr1System &&
              !hasValue(itemMap.customerMaterialNumber) &&
              hasValue(itemMap.supplierMaterialNumber)
            ) {
              itemMap.customerMaterialNumber = itemMap.supplierMaterialNumber;
            }

            if (hasValue(extractedItemNumberValue)) {
              itemMap.extractedItemNumber = extractedItemNumberValue;
            }

            if (!isPr1System) {
              itemMap.documentDate = itemDeliveryDateValue || documentDateValue || null;
            } else if (documentDateValue) {
              itemMap.documentDate = documentDateValue;
            }

            if (!itemMap.documentDate && effectiveDeliveryDate) {
              itemMap.documentDate = effectiveDeliveryDate;
            }

            itemIndex += 10;
            const itemNumberVal = itemIndex;

            if (Object.keys(itemMap).length === 0) continue;

            if (effectiveFormats) {
              const effectiveLineItemFormattingTargets = isPr1System
                ? {
                  ...lineItemFormattingTargets,
                  decimals: (lineItemFormattingTargets.decimals || []).filter(
                    (fieldName) => !pr1LineItemDecimalFieldsAsIs.includes(fieldName)
                  ),
                }
                : lineItemFormattingTargets;
              applyFieldFormatting(itemMap, effectiveLineItemFormattingTargets, effectiveFormats);
            }
            
            truncateRecordStringsByEntity(itemMap, DocumentLineItems);

            const existingItem = await tx.run(
              SELECT.one.from(DocumentLineItems).where({
                documentID_ID: documentId,
                itemNumber: itemNumberVal,
              })
            );

            if (existingItem) {
              await tx.run(
                UPDATE(DocumentLineItems)
                  .set(itemMap)
                  .where({ ID: existingItem.ID })
              );
            } else {
              itemMap.ID = cds.utils.uuid();
              itemMap.documentID_ID = documentId;
              itemMap.itemNumber = itemNumberVal;
              await tx.run(INSERT.into(DocumentLineItems).entries(itemMap));
            }
          }
        }

      }
      return {
        message: existing
          ? "Document updated with extraction"
          : "Document inserted with extraction",
        documentId,
        logId,
        hasExtraction: !!payload.extraction,
        updatedStatus: payload.statusDox || null,
      };
      });
    } catch (error) {
      // console.error("❌ Error in upsertDocument:", error);
      return req.reject(400, "Error to insert/update Document | " + error.message);
    }
  });

  srv.on("oDataDetermine", async (req) => {
    try {
      const rawBody = req.data?.body;
      const parsedInput =
        typeof rawBody === "string" && rawBody.trim()
          ? (() => {
              try {
                return parseExtractedJSON(rawBody);
              } catch (err) {
                return {};
              }
            })()
          : {};

      let persistenceContext = parsedInput?.body || parsedInput || req.data || {};

      if (typeof persistenceContext === "string") {
        try {
          persistenceContext = JSON.parse(persistenceContext);
        } catch (err) {
          persistenceContext = {};
        }
      }

      const attachmentId =
        pickValue(persistenceContext, [
          "attachmentId",
          "attachmentID",
          "AttachmentId",
          "AttachmentID",
          "attachmentid",
        ]) || pickValue(req.data, [
          "attachmentId",
          "attachmentID",
          "AttachmentId",
          "AttachmentID",
          "attachmentid",
        ]);

      const instanceId =
        pickValue(persistenceContext, [
          "instanceId",
          "instanceID",
          "InstanceId",
          "InstanceID",
          "instanceid",
        ]) || pickValue(req.data, [
          "instanceId",
          "instanceID",
          "InstanceId",
          "InstanceID",
          "instanceid",
        ]);
      const logId =
        pickValue(persistenceContext, [
          "logId",
          "LogId",
          "logID",
          "LogID",
        ]) ?? pickValue(req.data, [
          "logId",
          "LogId",
          "logID",
          "LogID",
        ]);

      if (!attachmentId || !instanceId) {
        req.error(400, "attachmentId and instanceId are mandatory");
        return;
      }

      const payloadResult = await buildODataPayloadFromDb(attachmentId, instanceId, req, logId);
      if (!payloadResult) {
        return;
      }
      const { payload, documentSystem } = payloadResult;
      const zsdService = await cds.connect.to("ZSD_SOA_SRV");
      console.log("Document System en oDataDetermine:", documentSystem )
      adjustZsdServiceForSystem(zsdService, payload, documentSystem);
      let result;
      if(documentSystem.toUpperCase() === "PR1"){
        let endpoint = `/SalesOrders`
        result = await zsdService.tx(req).post(endpoint, payload);
      }else {
         result = await zsdService.tx(req).post("/SalesOrders", payload);
      }

      if (result) {
        result.Nav_ShipTo = Array.isArray(result.Nav_ShipTo)
          ? result.Nav_ShipTo.slice(0, 9)
          : result.Nav_ShipTo;

        result.Nav_SoldTo = Array.isArray(result.Nav_SoldTo)
          ? result.Nav_SoldTo.slice(0, 9)
          : result.Nav_SoldTo;
      }

      await persistODataDetermineResult(
        result,
        {
          ...persistenceContext,
          attachmentId,
          instanceId,
          ...(logId !== null && logId !== undefined && logId !== ""
            ? { logId }
            : {}),
          documentSystem,
          logSource: "VALIDATE",
        },
        req
      );

      if(documentSystem.toUpperCase() === "PR1"){
        if (extractResultStatus(result) === "SUCCESS") {
          const taskId = pickValue(result, ["TaskID", "TaskId", "taskID", "taskId"]);
          const deleteResult = await deleteTaskId(taskId, zsdService, req);
        }
      }

      return result;
    } catch (error) {
      // console.error("Error in oDataDetermine:", error);
      req.error(400, "Error to Determine SO | " + error.message);
    }
  });

  srv.on("getDetermineResult", async (req) => {
    try {
      const payload = req.data || {};

      const filter = payload.filter;
      const expand = payload.expand;
      const persistResults = parseBooleanFlag(
        payload.persistResults
          ?? payload.PersistResults,
        false
      );

      if (!filter && !expand) {
        req.error(400, "You must provide at least one body property: filter or expand");
        return;
      }

      const externalService = await cds.connect.to("ZSD_SOA_SRV");
      adjustZsdServiceForSystem(externalService, payload, "PR1");

      const queryParts = [];
      if (filter) {
        queryParts.push(`$filter=${filter}`);
      }
      if (expand) {
        queryParts.push(`$expand=${expand}`);
      }

      const endpoint = queryParts.length
        ? `/SalesOrders?${queryParts.join("&")}`
        : "/SalesOrders";

      const rawResult = await externalService.tx(req).get(endpoint);
      const result = Array.isArray(rawResult)
        ? rawResult[0] || {}
        : rawResult;

      if (!persistResults) {
        return result;
      }

      const resultStatus = toStringSafe(
        result?.TaskStatus
        ?? result?.taskStatus
        ?? result?.Result?.TaskStatus
        ?? result?.Result?.taskStatus
        ?? result?.result?.TaskStatus
        ?? result?.result?.taskStatus
      )
        .trim()
        .toUpperCase();

      if (resultStatus !== "SUCCESS") {
        return result;
      }

      if (result) {
        result.Nav_ShipTo = Array.isArray(result.Nav_ShipTo)
          ? result.Nav_ShipTo.slice(0, 9)
          : result.Nav_ShipTo;

        result.Nav_SoldTo = Array.isArray(result.Nav_SoldTo)
          ? result.Nav_SoldTo.slice(0, 9)
          : result.Nav_SoldTo;
      }

      const attachmentId = pickValue(payload, [
        "attachmentId",
        "attachmentID",
        "AttachmentId",
        "AttachmentID",
        "attachmentid",
      ]);

      const instanceId = pickValue(payload, [
        "instanceId",
        "instanceID",
        "InstanceId",
        "InstanceID",
        "instanceid",
      ]);

      const logId =
        pickValue(payload, [
          "logId",
          "LogId",
          "logID",
          "LogID",
        ]);

      await persistODataDetermineResult(
        result,
        {
          ...payload,
          attachmentId,
          instanceId,
          ...(logId !== null && logId !== undefined && logId !== ""
            ? { logId }
            : {}),
          documentSystem: "PR1",
          logSource: "VALIDATE",
        },
        req
      );

      if (resultStatus === "SUCCESS") {
        const taskId = extractTaskIdFromFilter(filter);

        if (taskId) {
          const deleteResult = await deleteTaskId(taskId, externalService, req);
        }
      }

      return result;
    } catch (error) {
      req.error(400, "Error in getDetermineResult | " + error.message);
    }
  });

  srv.on("getSimulateResult", async (req) => {
    try {
      const payload = req.data || {};

      const filter = payload.filter;
      const expand = payload.expand;
      const persistResults = parseBooleanFlag(
        payload.persistResults
          ?? payload.PersistResults,
        false
      );

      if (!filter && !expand) {
        req.error(400, "You must provide at least one body property: filter or expand");
        return;
      }

      const externalService = await cds.connect.to("ZSD_SOA_SRV");
      adjustZsdServiceForSystem(externalService, payload, "PR1");

      const queryParts = [];
      if (filter) {
        queryParts.push(`$filter=${filter}`);
      }
      if (expand) {
        queryParts.push(`$expand=${expand}`);
      }

      const endpoint = queryParts.length
        ? `/SimulateSOs?${queryParts.join("&")}`
        : "/SimulateSOs";

      const rawResult = await externalService.tx(req).get(endpoint);
      const result = Array.isArray(rawResult)
        ? rawResult[0] || {}
        : rawResult;
      const resultStatus = toStringSafe(
        result?.TaskStatus
        ?? result?.taskStatus
        ?? result?.Result?.TaskStatus
        ?? result?.Result?.taskStatus
        ?? result?.result?.TaskStatus
        ?? result?.result?.taskStatus
      ).trim().toUpperCase();


      if (!persistResults) {
        if (resultStatus === "SUCCESS") {
          const taskId = extractTaskIdFromFilter(filter);
          if (taskId) {
            const deleteResult = await deleteTaskId(taskId, externalService, req);
          }
        }
        return result;
      }

      if (resultStatus === "SUCCESS") {
        const attachmentId = pickValue(payload, [
          "attachmentId",
          "attachmentID",
          "AttachmentId",
          "AttachmentID",
          "attachmentid",
        ]);

        const instanceId = pickValue(payload, [
          "instanceId",
          "instanceID",
          "InstanceId",
          "InstanceID",
          "instanceid",
        ]);

        const payloadFromDb = Boolean(attachmentId && instanceId);
        let documentIdForLogs = null;
        let documentSystem = "PR1";

        if (payloadFromDb) {
          const db = await cds.connect.to("db");
          const { Documents } = cds.entities("soautomation");
          const documentRecord = Documents
            ? await db.run(
                SELECT.one
                  .from(Documents)
                  .columns("ID", "system")
                  .where({ attachmentId, instanceId })
              )
            : null;

          documentIdForLogs = toStringSafe(documentRecord?.ID) || null;
          documentSystem = toStringSafe(documentRecord?.system) || documentSystem;
        }

        await persistSimulateResult(
          result,
          {
            payloadFromDb,
            documentIdForLogs,
            documentSystem,
          }
        );
      }

      if (resultStatus === "SUCCESS") {
        const taskId = extractTaskIdFromFilter(filter);

        if (taskId) {
          const deleteResult = await deleteTaskId(taskId, externalService, req);
        }
      }

      return result;
    } catch (error) {
      req.error(400, "Error in getSimulateResult | " + error.message);
    }
  });

  srv.on("getCreationResult", async (req) => {
    try {
      const payload = req.data || {};

      const taskIds = ensureArray(payload.taskId)
        .map((value) => toStringSafe(value))
        .filter(Boolean);
      const expand = payload.expand;
      const filterParam = payload.filter;
      const individualCreation = parseBooleanFlag(payload.individualCreation, false);

      if (taskIds.length === 0) {
        req.error(400, "taskId is required");
        return;
      }

      const externalService = await cds.connect.to("ZSD_SOA_SRV");
      adjustZsdServiceForSystem(externalService, payload, "PR1");

      const attachmentId = pickValue(payload, [
        "attachmentId",
        "attachmentID",
        "AttachmentId",
        "AttachmentID",
        "attachmentid",
      ]);

      const instanceId = pickValue(payload, [
        "instanceId",
        "instanceID",
        "InstanceId",
        "InstanceID",
        "instanceid",
      ]);

      const payloadFromDb = Boolean(attachmentId && instanceId);
      let documentIdForLogs = null;
      let documentSystem = toStringSafe(payload?.system) || "PR1";
      let lineItemsForUpdate = [];

      if (payloadFromDb) {
        const documentData = await fetchDocumentForOData(attachmentId, instanceId, req);
        if (documentData) {
          documentIdForLogs = toStringSafe(documentData.documentId) || null;
          documentSystem = toStringSafe(documentData.document?.system) || documentSystem;
          lineItemsForUpdate = ensureArray(documentData.lineItems);
        }
      }

      const creationType = payloadFromDb ? "Automatically" : "Manual";
      const orderCreatedBy = toStringSafe(req.user?.id) || "system";

      const taskFetches = await Promise.all(
        taskIds.map(async (taskId) => {
          const queryParts = [];
          const baseFilter = filterParam || `TaskID eq '${taskId}'`;
          queryParts.push(`$filter=${baseFilter}`);
          if (expand) {
            queryParts.push(`$expand=${expand}`);
          }
          const endpoint = `/CreateSOs?${queryParts.join("&")}`;
          const rawResult = await externalService.tx(req).get(endpoint);
          const result = Array.isArray(rawResult)
            ? rawResult[0] || {}
            : rawResult;
          return { taskId, result };
        })
      );

      const isEmptyResult = (value) => {
        if (value == null) return true;
        if (Array.isArray(value)) return value.length === 0;
        if (typeof value === "object") return Object.keys(value).length === 0;
        return false;
      };

      const taskOutcomes = taskFetches.map(({ taskId, result }, index) => {
        const taskStatus = toStringSafe(
          pickValue(result, ["TaskStatus", "taskStatus"])
        )
          .trim()
          .toUpperCase();
        const resolvedTaskId =
          toStringSafe(
            pickValue(result, ["TaskID", "TaskId", "taskID", "taskId"])
          ) || taskId;

        return {
          index,
          result,
          resolvedTaskId,
          taskStatus,
          isEmpty: isEmptyResult(result),
        };
      });

      if (taskIds.length === 1) {
        const single = taskOutcomes[0];
        if (single && !single.isEmpty && single.taskStatus !== "PENDING") {
          await persistanceODataCreateResult({
            req,
            result: single.result,
            resultList: individualCreation ? [single.result] : [],
            individualCreation,
            requestData: payload,
            documentIdForLogs,
            lineItemsForUpdate,
            documentSystem,
            payloadFromDb,
            creationType,
            orderCreatedBy,
          });
          if (single.taskStatus === "SUCCESS" && single.resolvedTaskId) {
            await deleteTaskId(single.resolvedTaskId, externalService, req);
          }
        }
        return taskFetches[0].result;
      }

      // With multiple taskIds every OData response has already been awaited
      // above (Promise.all). Persist them together (one response per line
      // item) so that each line item is reconciled against its own SalesOrder
      // instead of every task repeatedly resolving only the first line item.
      const processableOutcomes = taskOutcomes.filter(
        (outcome) => !outcome.isEmpty && outcome.taskStatus !== "PENDING"
      );

      if (processableOutcomes.length > 0) {
        const resultListForPersistence = processableOutcomes.map((outcome) => ({
          ...outcome.result,
          lineItemId: lineItemsForUpdate[outcome.index]?.ID,
        }));

        await persistanceODataCreateResult({
          req,
          result: resultListForPersistence[0],
          resultList: resultListForPersistence,
          individualCreation: true,
          requestData: payload,
          documentIdForLogs,
          lineItemsForUpdate,
          documentSystem,
          payloadFromDb,
          creationType,
          orderCreatedBy,
        });
      }

      const results = [];
      const errors = [];
      const pendingItems = [];

      for (const outcome of taskOutcomes) {
        if (outcome.isEmpty) {
          continue;
        }

        if (outcome.taskStatus === "PENDING") {
          pendingItems.push(outcome.resolvedTaskId);
          continue;
        }

        if (outcome.taskStatus === "SUCCESS") {
          if (outcome.resolvedTaskId) {
            const deleteResult = await deleteTaskId(outcome.resolvedTaskId, externalService, req);
          }
        }

        const navReturns = ensureArray(outcome.result?.Nav_Return);
        const hasError = navReturns.some((entry) => entry?.Type === "E");
        if (hasError) {
          errors.push(outcome.result);
        } else {
          results.push(outcome.result);
        }
      }

      return {
        results,
        errors,
        pendingItems,
      };
    } catch (error) {
      req.error(400, "Error in getCreationResult | " + error.message);
    }
  });

  srv.on("updateDocument", async (req) => {
    try {
      const payload = req.data?.data;
      if (!payload || typeof payload !== "object") {
        req.error(400, "Missing request payload");
        return;
      }

      const userEmail = req.user?.attr?.email ?? null;

      const payloadDocumentId = pickValue(payload, ["ID", "Id", "id"]);
      const attachmentId = pickValue(payload, ["attachmentId", "attachmentID", "AttachmentId", "AttachmentID"]);
      const instanceId = pickValue(payload, ["instanceId", "InstanceId", "instanceID", "InstanceID"]);

      if (!payloadDocumentId && (!attachmentId || !instanceId)) {
        req.error(400, "Either ID or both attachmentId and instanceId are mandatory");
        return;
      }

      const entities = cds.entities("soautomation");
      if (!entities) {
        req.error(400, "CAP Service metadata not available");
        return;
      }

      const {
        Documents,
        DocumentHeaders,
        DocumentHeaderStats,
        DocumentLineItems,
        DocumentPrices,
        DocumentTexts,
        DocumentPartners,
        DocumentSoldToOptions,
        DocumentShipToOptions,
        DocumentMaterialOptions,
        DocumentPackProposal,
        DocumentFieldHistories,
        DocumentErrorLogs,
      } = entities;

      const tx = cds.transaction(req) || await cds.connect.to("db");

      const documentSelector = payloadDocumentId
        ? { ID: payloadDocumentId }
        : { attachmentId, instanceId };

      const existingDocument = await tx.run(
        SELECT.one
          .from(Documents)
          .where(documentSelector)
      );

      if (!existingDocument) {
        req.error(404, "Document not found for provided identifiers");
        return;
      }

      const documentId = existingDocument.ID;
      const documentSystem = String(existingDocument.system || "").toUpperCase();

      if (documentSystem === "PR1" && DocumentErrorLogs) {
        await tx.run(
          DELETE.from(DocumentErrorLogs).where({ documentID_ID: documentId })
        );
      }

      const documentFields = [
        "status",
        "subject",
        "remark",
        "customer",
        "fileName",
        "emailSender",
        "receivedDatetime",
        "statusDox",
        "schemaName",
        "schemaVersion",
      ];

      const documentUpdate = {};
      let remarkChanged = false;
      for (const field of documentFields) {
        if (Object.prototype.hasOwnProperty.call(payload, field)) {
          if (field === "remark") {
            const nextRemark = payload[field];
            const currentRemark = existingDocument?.remark;
            const normalizedNextRemark = nextRemark == null ? "" : String(nextRemark);
            const normalizedCurrentRemark = currentRemark == null ? "" : String(currentRemark);

            if (normalizedNextRemark !== normalizedCurrentRemark) {
              documentUpdate[field] = nextRemark;
              remarkChanged = true;
            }
            continue;
          }

          documentUpdate[field] = payload[field];
        }
      }

      if (remarkChanged) {
        documentUpdate.remarkUpdatedBy = toStringSafe(req.user?.id).trim()
          || toStringSafe(req.user?.attr?.email).trim()
          || null;
        documentUpdate.remarkUpdatedOn = new Date();
      }

      const processingStatus = pickValue(payload, ["status", "Status"]);
      if (processingStatus !== undefined) {
        const statusValue = String(processingStatus);
        documentUpdate.status =
          statusValue.toLowerCase() === "completed" ? "COMPLETED" : statusValue;
      }

      if (Object.keys(documentUpdate).length > 0) {
        await tx.run(
          UPDATE(Documents)
            .set(documentUpdate)
            .where({ ID: documentId })
        );

        if (documentUpdate.status === "COMPLETED") {
          await stampDocumentCompletion(tx, documentId, resolveUserEmail(req));
        }
      }

      const payloadSalesOrderValue = pickValue(payload, ["SalesOrder", "salesOrder"]);
      const payloadSalesOrder =
        payloadSalesOrderValue !== undefined
          ? String(payloadSalesOrderValue).slice(0, 100)
          : undefined;

      const toArray = (value) => (Array.isArray(value) ? value : []);
      const historyEntity = DocumentFieldHistories;
      const headerTrackedFields = FIELD_TRACKING_TARGETS.DocumentHeaders || [];

      const headerFields = [
        "documentNumber",
        "taxId",
        "dtmCSR",
        "dtmUoM",
        "internal",
        "quantity",
        "senderId",
        "shipToId",
        "netAmount",
        "senderFax",
        "shipToFax",
        "receiverId",
        "senderCity",
        "senderName",
        "shipToCity",
        "shipToName",
        "dtmDivision",
        "dtmSalesOrg",
        "dtmOrderType",
        "grossAmount",
        "senderEmail",
        "senderPhone",
        "senderState",
        "shipToEmail",
        "shipToPhone",
        "shipToState",
        "taxIdNumber",
        "currencyCode",
        "documentDate",
        "deliveryDate",
        "customerRefDate",
        "sentDate",
        "paymentTerms",
        "senderStreet",
        "shipToStreet",
        "senderAddress",
        "shipToAddress",
        "shippingTerms",
        "senderDistrict",
        "shipToDistrict",
        "senderPostalCode",
        "shipToPostalCode",
        "senderBankAccount",
        "senderCountryCode",
        "senderHouseNumber",
        "shipToCountryCode",
        "shipToHouseNumber",
        "senderExtraAddressPart",
        "shipToExtraAddressPart",
        "salesGroup",
        "salesGroupDescription",
        "priceGroup",
        "priceGroupDescription",
        "deliveryTerm",
        "priceDate"
      ];

      const headerInputs = toArray(payload.DocumentHeaders);
      if (headerInputs.length > 0) {
        const headerDecimalFields = new Set(["netAmount", "grossAmount", "quantity"]);
        const coerceDecimalOrNull = (value) => {
          if (value === undefined || value === null || value === "") return value;
          if (typeof value === "number") {
            return Number.isFinite(value) ? value : null;
          }

          const sanitized = sanitizeQuantityValue(value);
          return sanitized === null ? null : sanitized;
        };

        const existingHeaders = await tx.run(
          SELECT.from(DocumentHeaders).where({ documentID_ID: documentId })
        );
        const headersById = new Map(
          existingHeaders.map((header) => [String(header.ID), header])
        );

        for (let index = 0; index < headerInputs.length; index++) {
          const headerInput = headerInputs[index];
          if (!headerInput || typeof headerInput !== "object") continue;

          const updateData = {};
          for (const field of headerFields) {
            if (Object.prototype.hasOwnProperty.call(headerInput, field)) {
              if (headerDecimalFields.has(field)) {
                updateData[field] = coerceDecimalOrNull(headerInput[field]);
              } else {
                updateData[field] = headerInput[field];
              }
            }
          }

          const hasSentDate = Object.prototype.hasOwnProperty.call(
            headerInput,
            "sentDate"
          );
          const hasDocumentDate = Object.prototype.hasOwnProperty.call(
            headerInput,
            "documentDate"
          );

          const hasPriceDate = Object.prototype.hasOwnProperty.call(
            headerInput,
            "priceDate"
          );

          if (hasPriceDate && documentSystem === 'PR1' ){
            updateData.priceDate =  headerInput.priceDate
          }

          if (hasSentDate && documentSystem !== "PR1") {
            updateData.sentDate = headerInput.sentDate;
          } else if (hasDocumentDate && documentSystem !== "PR1") {
            updateData.sentDate = headerInput.documentDate;
          }

          if (hasDocumentDate && documentSystem === "PR1") {
            updateData.documentDate = headerInput.documentDate;
          }

          if (Object.keys(updateData).length === 0) continue;

          let targetHeader = null;
          const headerId = headerInput.ID;
          if (headerId) {
            targetHeader = headersById.get(String(headerId));
          }
          if (!targetHeader && existingHeaders[index]) {
            targetHeader = existingHeaders[index];
          }

          if (targetHeader) {
            await trackFieldChanges(tx, historyEntity, {
              documentId,
              entityName: "DocumentHeaders",
              recordId: targetHeader.ID,
              existingRecord: targetHeader,
              updateData,
              trackedFields: headerTrackedFields,
              userEmail,
            });

            await tx.run(
              UPDATE(DocumentHeaders)
                .set(updateData)
                .where({ ID: targetHeader.ID })
            );
          } else {
            updateData.ID = cds.utils.uuid();
            updateData.documentID_ID = documentId;
            await tx.run(INSERT.into(DocumentHeaders).entries(updateData));
            await trackFieldChanges(tx, historyEntity, {
              documentId,
              entityName: "DocumentHeaders",
              recordId: updateData.ID,
              updateData,
              trackedFields: headerTrackedFields,
              userEmail,
            });
          }
        }
      }

      const parseItemNumber = (value) => {
        if (value === undefined || value === null) return null;
        if (typeof value === "number" && Number.isFinite(value)) {
          return Math.trunc(value);
        }
        const str = String(value).trim();
        if (!str) return null;
        const direct = Number(str);
        if (Number.isFinite(direct)) {
          return Math.trunc(direct);
        }
        const parsed = parseInt(str.replace(/^0+/, ""), 10);
        return Number.isNaN(parsed) ? null : parsed;
      };

      const lineItemFields = [
        "itemNumber",
        "customerMaterialNumber",
        "SAPMaterialNo",
        "SAPMaterialDescription",
        "SAPUnitPrice",
        "supplierMaterialNumber",
        "description",
        "quantity",
        "unitPrice",
        "netAmount",
        "unitOfMeasure",
        "currencyCode",
        "documentDate",
        "incoTerm1",
        "incoTerm2",
        "SAPItemNetValue",
        "SAPUnitOfMeasure",
        "SAPQuantity",
        "shippingType",
        "GIDate",
        "LoadDate",
        "MSDate",
        "TPDate",
        "ItemCategory",
        "Plant",
        "Route",
        "ConfDelDate",
        "CondGrp1",
        "PackAvl",
        "documentNumber",
        "SAPCustMatNum",
        "SAPCustMatDesc",
        "Kdkgl",
        "manuallyAdded"
      ];
      const lineTrackedFields = FIELD_TRACKING_TARGETS.DocumentLineItems || [];

      const lineItemInputs = toArray(payload.DocumentLineItems);
      const stampableLineItemIds = [];
      if (lineItemInputs.length > 0) {
        const existingItems = await tx.run(
          SELECT.from(DocumentLineItems).where({ documentID_ID: documentId })
        );
        const itemsById = new Map(existingItems.map((item) => [String(item.ID), item]));
        const itemsByNumber = new Map(
          existingItems
            .filter((item) => item.itemNumber !== undefined && item.itemNumber !== null)
            .map((item) => [String(item.itemNumber), item])
        );

        for (const lineInput of lineItemInputs) {
          if (!lineInput || typeof lineInput !== "object") continue;

          const updateData = {};
          for (const field of lineItemFields) {
            if (Object.prototype.hasOwnProperty.call(lineInput, field)) {
              updateData[field] = lineInput[field];
            }
          }

          const itemSalesOrderValue = pickValue(lineInput, ["SalesOrder", "salesOrder"]);
          const incoTerm1 = pickValue(lineInput, ["incoterm1", "incoterms1", "IncoTerm1"]);
          const incoTerm2 = pickValue(lineInput, ["incoterm2", "incoterms2", "IncoTerm2"]);
          if (itemSalesOrderValue !== undefined) {
            updateData.SalesOrder = String(itemSalesOrderValue).slice(0, 100);
          } else if (payloadSalesOrder !== undefined) {
            updateData.SalesOrder = payloadSalesOrder;
          }

          if (incoTerm1 !== undefined) {
            updateData.incoTerm1 = incoTerm1;
          }
          if (incoTerm2 !== undefined) {
            updateData.incoTerm2 = incoTerm2;
          }

          if (Object.keys(updateData).length === 0) continue;

          const parsedNumber = Object.prototype.hasOwnProperty.call(lineInput, "itemNumber")
            ? parseItemNumber(lineInput.itemNumber)
            : null;

          let targetItem = null;
          const itemId = pickValue(lineInput, ["ID", "Id", "id"]);
          if (itemId) {
            targetItem = itemsById.get(String(itemId));
          }
          if (!targetItem && parsedNumber !== null) {
            targetItem = itemsByNumber.get(String(parsedNumber));
          }

          //Automatically add "manuallyAdded" : true to line items
          const payloadManuallyAdded = lineInput.manuallyAdded === true || String(lineInput.manuallyAdded).toLowerCase() === "true";
          if (!targetItem) {
            updateData.manuallyAdded = true;
          }

          if (payloadManuallyAdded) {
            updateData.manuallyAdded = true;
          }

          if (targetItem) {
            await trackFieldChanges(tx, historyEntity, {
              documentId,
              entityName: "DocumentLineItems",
              recordId: targetItem.ID,
              existingRecord: targetItem,
              updateData,
              trackedFields: lineTrackedFields,
              userEmail,
            });
            await tx.run(
              UPDATE(DocumentLineItems)
                .set(updateData)
                .where({ ID: targetItem.ID })
            );
            if (
              Object.prototype.hasOwnProperty.call(updateData, "SalesOrder") &&
              toStringSafe(updateData.SalesOrder).trim()
            ) {
              stampableLineItemIds.push(targetItem.ID);
            }
          } else {
            if (!Object.prototype.hasOwnProperty.call(updateData, "itemNumber")) {
              if (parsedNumber === null) {
                continue;
              }
              updateData.itemNumber = parsedNumber;
            }
            if (parsedNumber !== null) {
              updateData.itemNumber = parsedNumber;
            }
            updateData.ID = cds.utils.uuid();
            updateData.documentID_ID = documentId;
            await tx.run(INSERT.into(DocumentLineItems).entries(updateData));
            await trackFieldChanges(tx, historyEntity, {
              documentId,
              entityName: "DocumentLineItems",
              recordId: updateData.ID,
              updateData,
              trackedFields: lineTrackedFields,
              userEmail,
            });
            if (
              Object.prototype.hasOwnProperty.call(updateData, "SalesOrder") &&
              toStringSafe(updateData.SalesOrder).trim()
            ) {
              stampableLineItemIds.push(updateData.ID);
            }
          }
        }
      }

      if (stampableLineItemIds.length > 0) {
        await stampLineItemCompletion(
          tx,
          documentId,
          resolveUserEmail(req),
          stampableLineItemIds
        );
      }

      const priceFields = [
        "itemNumber",
        "condType",
        "Vtext",
        "CondValue",
        "Currency",
        "CondUnit",
        "CondPricingUnit",
        "CondPriceDate",
        "manuallyAdded",
      ];

      const priceTrackedFields = FIELD_TRACKING_TARGETS.DocumentPrices || [];
      const priceInputs = toArray(payload.DocumentPrices);
      if (priceInputs.length > 0) {
        const existingPrices = await tx.run(
          SELECT.from(DocumentPrices).where({ documentID_ID: documentId })
        );
        const pricesById = new Map(
          existingPrices.map((price) => [String(price.ID), price])
        );
        const pricesByKey = new Map(
          existingPrices.map((price) => [
            `${price.itemNumber ?? ""}|${price.condType ?? ""}|${price.Vtext ?? ""}`,
            price,
          ])
        );

        for (const priceInput of priceInputs) {
          if (!priceInput || typeof priceInput !== "object") continue;

          const updateData = {};
          for (const field of priceFields) {
            if (Object.prototype.hasOwnProperty.call(priceInput, field)) {
              updateData[field] = priceInput[field];
            }
          }

          const priceManuallyAdded = parseBooleanFlag(priceInput.manuallyAdded);
          if (priceManuallyAdded === true) {
            updateData.manuallyAdded = true;
          }

          if (Object.keys(updateData).length === 0) continue;

          const parsedNumber = Object.prototype.hasOwnProperty.call(priceInput, "itemNumber")
            ? parseItemNumber(priceInput.itemNumber)
            : null;

          if (parsedNumber !== null) {
            updateData.itemNumber = parsedNumber;
          }

          let targetPrice = null;
          const priceId = pickValue(priceInput, ["ID", "Id", "id"]);
          if (priceId) {
            targetPrice = pricesById.get(String(priceId));
          }
          if (!targetPrice) {
            const compositeKey = `${parsedNumber ?? ""}|${priceInput.condType ?? ""}|${priceInput.Vtext ?? ""}`;
            targetPrice = pricesByKey.get(compositeKey);
          }

          if (targetPrice) {
            await trackFieldChanges(tx, historyEntity, {
              documentId,
              entityName: "DocumentPrices",
              recordId: targetPrice.ID,
              existingRecord: targetPrice,
              updateData,
              trackedFields: priceTrackedFields,
              userEmail,
            });
            await tx.run(
              UPDATE(DocumentPrices)
                .set(updateData)
                .where({ ID: targetPrice.ID })
            );
          } else {
            if (!Object.prototype.hasOwnProperty.call(updateData, "itemNumber")) {
              if (parsedNumber === null) {
                continue;
              }
              updateData.itemNumber = parsedNumber;
            }
            updateData.ID = cds.utils.uuid();
            updateData.documentID_ID = documentId;
            await tx.run(INSERT.into(DocumentPrices).entries(updateData));
          }
        }
      }

      const textFields = [
        "itemNumber",
        "textName",
        "text",
        "textId",
        "lang",
        "manuallyAdded",
      ];

      const textTrackedFields = FIELD_TRACKING_TARGETS.DocumentTexts || [];
      if (
        DocumentTexts
        && documentSystem === "PR1"
        && Object.prototype.hasOwnProperty.call(payload, "DocumentTexts")
      ) {
        const textInputs = toArray(payload.DocumentTexts);

        const existingTexts = await tx.run(
          SELECT.from(DocumentTexts).where({ documentID_ID: documentId })
        );
        const textsByKey = new Map(
          existingTexts.map((t) => [
            `${t.itemNumber ?? ""}|${t.textName ?? ""}|${t.textId ?? ""}`,
            t,
          ])
        );

        for (const textInput of textInputs) {
          if (!textInput || typeof textInput !== "object") continue;

          const parsedNumber = Object.prototype.hasOwnProperty.call(textInput, "itemNumber")
            ? parseItemNumber(textInput.itemNumber)
            : null;

          if (parsedNumber === null) continue;

          const compositeKey = `${parsedNumber}|${textInput.textName ?? ""}|${textInput.textId ?? ""}`;
          const existingText = textsByKey.get(compositeKey);
          if (existingText) {
            const incomingData = {};
            for (const field of textTrackedFields) {
              if (Object.prototype.hasOwnProperty.call(textInput, field)) {
                incomingData[field] = textInput[field];
              }
            }
            await trackFieldChanges(tx, historyEntity, {
              documentId,
              entityName: "DocumentTexts",
              recordId: compositeKey,
              existingRecord: existingText,
              updateData: incomingData,
              trackedFields: textTrackedFields,
              userEmail,
            });
          }
        }

        await tx.run(
          DELETE.from(DocumentTexts).where({ documentID_ID: documentId })
        );

        for (const textInput of textInputs) {
          if (!textInput || typeof textInput !== "object") continue;

          const updateData = {};
          for (const field of textFields) {
            if (Object.prototype.hasOwnProperty.call(textInput, field)) {
              updateData[field] = textInput[field];
            }
          }

          const textManuallyAdded = parseBooleanFlag(textInput.manuallyAdded);
          if (textManuallyAdded === true) {
            updateData.manuallyAdded = true;
          }

          if (Object.keys(updateData).length === 0) continue;

          const parsedNumber = Object.prototype.hasOwnProperty.call(textInput, "itemNumber")
            ? parseItemNumber(textInput.itemNumber)
            : null;

          if (parsedNumber === null) {
            continue;
          }

          updateData.itemNumber = parsedNumber;
          updateData.ID = cds.utils.uuid();
          updateData.documentID_ID = documentId;
          await tx.run(INSERT.into(DocumentTexts).entries(updateData));
          const textRecordId = `${parsedNumber}|${textInput.textName ?? ""}|${textInput.textId ?? ""}`;
          await trackFieldChanges(tx, historyEntity, {
            documentId,
            entityName: "DocumentTexts",
            recordId: textRecordId,
            updateData,
            trackedFields: textTrackedFields,
            userEmail,
          });
        }
      }

      const partnerFields = [
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
      ];
      const partnerTrackedFields = FIELD_TRACKING_TARGETS.DocumentPartners || [];
      const partnerInputs = toArray(payload.DocumentPartners);
      if (partnerInputs.length > 0 && DocumentPartners) {
        const existingPartners = await tx.run(
          SELECT.from(DocumentPartners).where({ documentID_ID: documentId })
        );
        const partnersById = new Map(existingPartners.map((partner) => [String(partner.ID), partner]));

        for (let index = 0; index < partnerInputs.length; index++) {
          const partnerInput = partnerInputs[index];
          if (!partnerInput || typeof partnerInput !== "object") continue;

          const updateData = {};
          for (const field of partnerFields) {
            if (Object.prototype.hasOwnProperty.call(partnerInput, field)) {
              updateData[field] = partnerInput[field];
            }
          }

          if (Object.keys(updateData).length === 0) continue;

          let targetPartner = null;
          const partnerId = pickValue(partnerInput, ["ID", "Id", "id"]);
          if (partnerId) {
            targetPartner = partnersById.get(String(partnerId));
          }
          if (!targetPartner && existingPartners[index]) {
            targetPartner = existingPartners[index];
          }

          if (targetPartner) {
            await trackFieldChanges(tx, historyEntity, {
              documentId,
              entityName: "DocumentPartners",
              recordId: targetPartner.ID,
              existingRecord: targetPartner,
              updateData,
              trackedFields: partnerTrackedFields,
              userEmail,
            });
            await tx.run(
              UPDATE(DocumentPartners)
                .set(updateData)
                .where({ ID: targetPartner.ID })
            );
          } else {
            updateData.ID = cds.utils.uuid();
            updateData.documentID_ID = documentId;
            await tx.run(INSERT.into(DocumentPartners).entries(updateData));
            await trackFieldChanges(tx, historyEntity, {
              documentId,
              entityName: "DocumentPartners",
              recordId: updateData.ID,
              updateData,
              trackedFields: partnerTrackedFields,
              userEmail,
            });
          }
        }
      }

      if (DocumentPackProposal && Object.prototype.hasOwnProperty.call(payload, "DocumentPackProposal")) {
        const packProposalInputs = toArray(payload.DocumentPackProposal);
        const packProposalFields = [
          "ProposalType",
          "ItemNumber",
          "UnqKey",
          "HandlingUnit",
          "IPCMaterial",
          "PackMaterial",
          "PackMatDesc",
          "Quantity",
          "UnitOfMeasure",
          "PackInstruction",
          "NoOfHU",
          "SalesOrg",
          "DistChannel",
          "ShipToId",
          "RequestMaterial",
          "RequestPlant",
          "RequestQuantity",
          "RequestUnitOfMeasure",
        ];
        const packDecimalFields = new Set(["Quantity", "RequestQuantity"]);

        await tx.run(
          DELETE.from(DocumentPackProposal).where({ documentID_ID: documentId })
        );

        for (const packProposalInput of packProposalInputs) {
          if (!packProposalInput || typeof packProposalInput !== "object") continue;

          const updateData = {};
          for (const field of packProposalFields) {
            if (Object.prototype.hasOwnProperty.call(packProposalInput, field)) {
              if (packDecimalFields.has(field)) {
                updateData[field] = sanitizeQuantityValue(packProposalInput[field]);
              } else {
                updateData[field] = packProposalInput[field];
              }
            }
          }

          if (Object.keys(updateData).length === 0) continue;

          updateData.ID = cds.utils.uuid();
          updateData.documentID_ID = documentId;
          await tx.run(INSERT.into(DocumentPackProposal).entries(updateData));
        }
      }

      const soldOptionFields = ["soldToId", "soldToName", "soldToAddress", "isSelected"];
      const soldInputs = toArray(payload.DocumentSoldToOptions);
      if (soldInputs.length > 0) {
        const existingSold = await tx.run(
          SELECT.from(DocumentSoldToOptions).where({ documentID_ID: documentId })
        );
        const soldById = new Map(existingSold.map((option) => [String(option.ID), option]));
        const soldByKey = new Map(
          existingSold.map((option) => [
            `${option.soldToId ?? ""}|${option.soldToName ?? ""}`,
            option,
          ])
        );

        for (let index = 0; index < soldInputs.length; index++) {
          const option = soldInputs[index];
          if (!option || typeof option !== "object") continue;

          const updateData = {};
          for (const field of soldOptionFields) {
            if (Object.prototype.hasOwnProperty.call(option, field)) {
              updateData[field] = option[field];
            }
          }

          if (Object.keys(updateData).length === 0) continue;

          let target = null;
          const optionId = option.ID;
          if (optionId) {
            target = soldById.get(String(optionId));
          }
          if (!target && option.soldToId) {
            const key = `${option.soldToId}|${option.soldToName ?? ""}`;
            target = soldByKey.get(key);
          }
          if (!target && existingSold[index]) {
            target = existingSold[index];
          }

          if (target) {
            await tx.run(
              UPDATE(DocumentSoldToOptions)
                .set(updateData)
                .where({ ID: target.ID })
            );
          } else {
            updateData.ID = cds.utils.uuid();
            updateData.documentID_ID = documentId;
            if (!Object.prototype.hasOwnProperty.call(updateData, "isSelected")) {
              updateData.isSelected = false;
            }
            await tx.run(INSERT.into(DocumentSoldToOptions).entries(updateData));
          }
        }
      }

      const headerStatFields = [
        "purchaseOrderNumber",
        "purchaseOrderDate",
        "orderType",
        "salesOrg",
        "shipToName",
        "shipToId",
        "shipToAddress",
        "soldToName",
        "soldToId",
        "soldToAddress",
        "SAPNetVal",
        "SAPCurrencyCode",
        "TermsOfPaymentDesc",
        "TermsOfPayment",
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

      const headerStatTrackedFields = FIELD_TRACKING_TARGETS.DocumentHeaderStats || [];
      const statInputs = toArray(payload.DocumentHeaderStats);
      if (statInputs.length > 0 && DocumentHeaderStats) {
        const existingStats = await tx.run(
          SELECT.from(DocumentHeaderStats).where({ documentID_ID: documentId })
        );
        const statsById = new Map(existingStats.map((stat) => [String(stat.ID), stat]));
        const statsByKey = new Map(
          existingStats.map((stat) => [
            `${stat.soldToId ?? ""}|${stat.shipToId ?? ""}|${stat.purchaseOrderNumber ?? ""}`,
            stat,
          ])
        );

        for (let index = 0; index < statInputs.length; index++) {
          const statInput = statInputs[index];
          if (!statInput || typeof statInput !== "object") continue;

          const updateData = {};
          for (const field of headerStatFields) {
            if (Object.prototype.hasOwnProperty.call(statInput, field)) {
              const val = statInput[field];
              if (val === "") {
                updateData[field] = null;
              } else {
                updateData[field] = val;
              }

            }
          }

          if (Object.keys(updateData).length === 0) continue;

          let targetStat = null;
          const statId = statInput.ID;
          if (statId) {
            targetStat = statsById.get(String(statId));
          }
          if (!targetStat) {
            const key = `${statInput.soldToId ?? ""}|${statInput.shipToId ?? ""}|${statInput.purchaseOrderNumber ?? ""}`;
            if (statsByKey.has(key)) {
              targetStat = statsByKey.get(key);
            }
          }
          if (!targetStat && existingStats[index]) {
            targetStat = existingStats[index];
          }

          // Ensure we update the existing record when one already exists for the document
          if (!targetStat && existingStats.length > 0) {
            targetStat = existingStats[0];
          }

          if (targetStat) {

            await trackFieldChanges(tx, historyEntity, {
              documentId,
              entityName: "DocumentHeaderStats",
              recordId: targetStat.ID,
              existingRecord: targetStat,
              updateData,
              trackedFields: headerStatTrackedFields,
              userEmail,
            });
            await tx.run(
              UPDATE(DocumentHeaderStats)
                .set(updateData)
                .where({ ID: targetStat.ID })
            );
          } else {
            updateData.ID = cds.utils.uuid();
            updateData.documentID_ID = documentId;
            await tx.run(INSERT.into(DocumentHeaderStats).entries(updateData));
            await trackFieldChanges(tx, historyEntity, {
              documentId,
              entityName: "DocumentHeaderStats",
              recordId: updateData.ID,
              updateData,
              trackedFields: headerStatTrackedFields,
              userEmail,
            });
          }
        }
      }

      const shipOptionFields = ["shipToId", "shipToName", "shipToAddress", "isSelected"];
      const shipInputs = toArray(payload.DocumentShipToOptions);
      if (shipInputs.length > 0) {
        const existingShip = await tx.run(
          SELECT.from(DocumentShipToOptions).where({ documentID_ID: documentId })
        );
        const shipById = new Map(existingShip.map((option) => [String(option.ID), option]));
        const shipByKey = new Map(
          existingShip.map((option) => [
            `${option.shipToId ?? ""}|${option.shipToName ?? ""}`,
            option,
          ])
        );

        for (let index = 0; index < shipInputs.length; index++) {
          const option = shipInputs[index];
          if (!option || typeof option !== "object") continue;

          const updateData = {};
          for (const field of shipOptionFields) {
            if (Object.prototype.hasOwnProperty.call(option, field)) {
              updateData[field] = option[field];
            }
          }

          if (Object.keys(updateData).length === 0) continue;

          let target = null;
          const optionId = option.ID;
          if (optionId) {
            target = shipById.get(String(optionId));
          }
          if (!target && option.shipToId) {
            const key = `${option.shipToId}|${option.shipToName ?? ""}`;
            target = shipByKey.get(key);
          }
          if (!target && existingShip[index]) {
            target = existingShip[index];
          }

          if (target) {
            await tx.run(
              UPDATE(DocumentShipToOptions)
                .set(updateData)
                .where({ ID: target.ID })
            );
          } else {
            updateData.ID = cds.utils.uuid();
            updateData.documentID_ID = documentId;
            if (!Object.prototype.hasOwnProperty.call(updateData, "isSelected")) {
              updateData.isSelected = false;
            }
            await tx.run(INSERT.into(DocumentShipToOptions).entries(updateData));
          }
        }
      }
      const materialOptionFields = ["materialNo", "materialDescription", "isSelected"];
      const materialInputs = toArray(payload.DocumentMaterialOptions);
      if (materialInputs.length > 0 && DocumentMaterialOptions) {
        const existingMaterials = await tx.run(
          SELECT.from(DocumentMaterialOptions).where({ documentID_ID: documentId })
        );
        const materialById = new Map(
          existingMaterials.map((option) => [String(option.ID), option])
        );
        const materialByKey = new Map(
          existingMaterials.map((option) => [
            `${option.materialNo ?? ""}|${option.materialDescription ?? ""}`,
            option,
          ])
        );

        for (let index = 0; index < materialInputs.length; index++) {
          const option = materialInputs[index];
          if (!option || typeof option !== "object") continue;

          const updateData = {};
          for (const field of materialOptionFields) {
            if (Object.prototype.hasOwnProperty.call(option, field)) {
              updateData[field] = option[field];
            }
          }

          if (Object.keys(updateData).length === 0) continue;

          let target = null;
          const optionId = option.ID;
          if (optionId) {
            target = materialById.get(String(optionId));
          }
          if (!target && option.materialNo) {
            const key = `${option.materialNo}|${option.materialDescription ?? ""}`;
            target = materialByKey.get(key);
          }
          if (!target && existingMaterials[index]) {
            target = existingMaterials[index];
          }

          if (target) {
            await tx.run(
              UPDATE(DocumentMaterialOptions)
                .set(updateData)
                .where({ ID: target.ID })
            );
          } else {
            updateData.ID = cds.utils.uuid();
            updateData.documentID_ID = documentId;
            if (!Object.prototype.hasOwnProperty.call(updateData, "isSelected")) {
              updateData.isSelected = false;
            }
            await tx.run(INSERT.into(DocumentMaterialOptions).entries(updateData));
          }
        }
      }
      const trainModelAI = parseBooleanFlag(payload.trainModelAI);
      if (trainModelAI) {
        try {
          await trainModelIfNeeded({
            requestData: payload,
            documentId,
            transaction: tx,
          });
        } catch (err) {
          console.error("Error training DOX model", err.message || err);
        }
      }

      await markDocumentCompletedIfProcessed(tx, documentId, resolveUserEmail(req));

      return {
        documentId,
        message: "Document updated successfully",
      };
    } catch (error) {
      // console.error("Error in updateDocument:", error);
      req.error(400, "Error to update Document | " + error.message);
    }
  });

  const persistSimulateResult = async (
    result,
    {
      payloadFromDb,
      documentIdForLogs,
      documentSystem,
    } = {}
  ) => {
    if (payloadFromDb && documentIdForLogs) {
      const simReturns = ensureArray(result?.Nav_SimReturn);
      const errors = simReturns.filter((entry) => entry?.Type === "E" || (entry?.Type === "W" && entry?.Id === "ZSOA"));
      const db = await cds.connect.to("db");
      const { DocumentErrorLogs } = cds.entities("soautomation");

      await db.run(
        DELETE.from(DocumentErrorLogs).where({ documentID_ID: documentIdForLogs })
      );

      if (errors.length > 0) {
        const errorEntries = errors.map((error) => ({
          ID: cds.utils.uuid(),
          documentID_ID: documentIdForLogs,
          type: toStringSafe(error.Type),
          message: toStringSafe(error.Message),
          number:
            documentSystem === "PR1"
              ? toStringSafe(error.Number)
              : `${toStringSafe(error.Id)} - ${toStringSafe(error.Number)} `,
          source: documentSystem === "PR1" ? "SIMULATE" : null,
        }));

        await db.run(INSERT.into(DocumentErrorLogs).entries(errorEntries));
      }

      // Inserta IncoTerm1, IncoTerm2, SAPItemNetValue, SAPUnitPrice a nivel line item y ademas inserta SAPNetVal a nivel DocumentHeaderStats
      const { DocumentHeaderStats, DocumentLineItems } = cds.entities("soautomation");

      const headerStat = ensureArray(result?.Nav_HeaderStat).find(
        (stat) => stat && typeof stat === "object"
      );

      if (DocumentHeaderStats && headerStat) {
        const headerUpdates = {};

        if (headerStat.NetVal !== undefined && headerStat.NetVal !== null) {
          headerUpdates.SAPNetVal = headerStat.NetVal ? headerStat.NetVal : null;
        }

        if (
          headerStat.CurrencyCode !== undefined &&
          headerStat.CurrencyCode !== null
        ) {
          headerUpdates.SAPCurrencyCode = toStringSafe(headerStat.CurrencyCode);
        }

        if (
          headerStat.TermsOfPaymentDesc !== undefined &&
          headerStat.TermsOfPaymentDesc !== null
        ) {
          headerUpdates.TermsOfPaymentDesc = toStringSafe(
            headerStat.TermsOfPaymentDesc
          );
        }

        if (headerStat.IncoTerm1 !== undefined && headerStat.IncoTerm1 !== null) {
          headerUpdates.incoTerm1 = toStringSafe(headerStat.IncoTerm1);
        }

        if (headerStat.IncoTerm1Desc !== undefined && headerStat.IncoTerm1Desc !== null) {
          headerUpdates.incoTerm1Desc = toStringSafe(headerStat.IncoTerm1Desc);
        }

        if (headerStat.IncoTerm2 !== undefined && headerStat.IncoTerm2 !== null) {
          headerUpdates.incoTerm2 = toStringSafe(headerStat.IncoTerm2);
        }

        if (headerStat.IncoTerm2Desc !== undefined && headerStat.IncoTerm2Desc !== null) {
          headerUpdates.incoTerm2Desc = toStringSafe(headerStat.IncoTerm2Desc);
        }

        if (Object.keys(headerUpdates).length > 0) {
          const existingHeaderStat = await db.run(
            SELECT.one.from(DocumentHeaderStats).where({ documentID_ID: documentIdForLogs })
          );

          if (existingHeaderStat) {
            await db.run(
              UPDATE(DocumentHeaderStats)
                .set(headerUpdates)
                .where({ ID: existingHeaderStat.ID })
            );
          }
        }
      }

      if (DocumentLineItems) {
        const lineItemUpdates = {};
        const parseItemNumberValue = (value) => {
          if (value === undefined || value === null) return null;
          const cleaned = String(value).trim();
          if (!cleaned) return null;
          const parsed = parseInt(cleaned.replace(/^0+/, ""), 10);
          return Number.isNaN(parsed) ? null : parsed;
        };

        if (headerStat) {
          if (headerStat.IncoTerm1 !== undefined && headerStat.IncoTerm1 !== null) {
            lineItemUpdates.incoTerm1 = headerStat.IncoTerm1;
          }

          if (headerStat.IncoTerm2 !== undefined && headerStat.IncoTerm2 !== null) {
            lineItemUpdates.incoTerm2 = headerStat.IncoTerm2;
          }
        }

        const itemStats = ensureArray(result?.Nav_ItemStat);
        for (const itemStat of itemStats) {
          if (!itemStat || typeof itemStat !== "object") continue;
          const itemUpdates = { ...lineItemUpdates };

          if (itemStat.ConditionVal !== undefined && itemStat.ConditionVal !== null) {
            const conditionVal = toStringSafe(itemStat.ConditionVal).trim();
            itemUpdates.SAPItemNetValue = conditionVal ? conditionVal : null;
          }

          if (itemStat.UnitPrice !== undefined && itemStat.UnitPrice !== null) {
            const unitPrice = toStringSafe(itemStat.UnitPrice).trim();
            itemUpdates.SAPUnitPrice = unitPrice ? unitPrice : null;
          }

          if (itemStat.UOM !== undefined && itemStat.UOM !== null) {
            itemUpdates.SAPUnitOfMeasure = toStringSafe(itemStat.UOM).trim();
          }
          if (itemStat.Quantity !== undefined && itemStat.Quantity !== null) {
            const quantity = toStringSafe(itemStat.Quantity).trim();
            itemUpdates.SAPQuantity = quantity ? quantity : null;
          }

          if (documentSystem === "PR1") {
            if (itemStat.Postx !== undefined && itemStat.Postx !== null) {
              const sapCustMatDesc = toStringSafe(itemStat.Postx).trim();
              itemUpdates.SAPCustMatDesc = sapCustMatDesc ? sapCustMatDesc : null;
            }
            if (itemStat?.Kdmat !== undefined && itemStat?.Kdmat !== null) {
              const sapCustMatNum = toStringSafe(itemStat.Kdmat).trim();
              itemUpdates.SAPCustMatNum = sapCustMatNum ? sapCustMatNum : null;
            }
            if (itemStat.ReqDate !== undefined && itemStat.ReqDate !== null) {
              const reqDate = normalizeDate(itemStat.ReqDate);
              itemUpdates.ConfDelDate = reqDate || null;
            }
          }
          // if (itemStat.Description !== undefined && itemStat.Description !== null) {
          //   itemUpdates.SAPMaterialDescription = itemStat.Description.trim();
          // }

          if (Object.keys(itemUpdates).length === 0) continue;

          const itemNumber = parseItemNumberValue(itemStat.ItemNumber);
          const whereClause = { documentID_ID: documentIdForLogs };
          if (Number.isInteger(itemNumber)) {
            whereClause.itemNumber = itemNumber;
          } else if (itemStat.MaterialNo) {
            whereClause.SAPMaterialNo = itemStat.MaterialNo;
          } else {
            continue;
          }

          await db.run(
            UPDATE(DocumentLineItems)
              .set(itemUpdates)
              .where(whereClause)
          );
        }
      }
    } else if (!payloadFromDb && documentIdForLogs) {
      const db = await cds.connect.to("db");
      const { DocumentErrorLogs } = cds.entities("soautomation");

      await db.run(
        DELETE.from(DocumentErrorLogs).where({ documentID_ID: documentIdForLogs })
      );
    }
  };

  srv.on("oDataSimulateOS", async (req) => {
    try {
      const requestData = req.data || {};
      const { attachmentId, instanceId } = requestData;
      const requestPriceDate = normalizeDate(
        pickValue(requestData, ["PriceDate", "priceDate"])
      );
      let documentIdForLogs = toStringSafe(requestData?.ID) || null;
      let documentSystem = null;
      let pr1Metadata = null;

      if ((attachmentId && !instanceId) || (!attachmentId && instanceId)) {
        req.error(400, "attachmentId and instanceId must be provided together");
        return;
      }

      const buildPayloadFromDb = async (attId, instId) => {
        const logId =
          typeof requestData?.logId === "string"
            ? requestData.logId.trim()
            : requestData?.logId;
        const documentData = await fetchDocumentForOData(attId, instId, req, logId);
        if (!documentData) {
          return null;
        }

        const { header, headerStats, lineItems, documentId, document } = documentData;
        documentSystem = document?.system || null;
        documentIdForLogs = documentId;
        const [emailData, logMetadata] = await Promise.all([
          fetchDocumentEmails(documentId),
          fetchDocumentLogMetadata(documentId),
        ]);
        const headerDocumentDate = normalizeDate(header.documentDate);
        const headerReqDate = normalizeDate(header.deliveryDate);
        const headerPriceDate = normalizeDate(
          pickValue(header, ["priceDate", "PriceDate", "createdAt", "created_at"])
        );
        const headerDocumentNumber = toStringSafe(header.documentNumber);
        const senderId = toStringSafe(headerStats?.soldToId);
        const shipToId = toStringSafe(headerStats?.shipToId);
        const shipToAddress = toStringSafe(headerStats?.shipToAddress);
        const itemSourceIds = [
          ...new Set(
            ensureArray(lineItems)
              .flatMap((item) => [item?.ID, item?.itemNumber])
              .map((value) => toStringSafe(value))
              .filter(Boolean)
          ),
        ];
        const itemHistoryMap = await fetchItemHistoryMap(
          documentId,
          itemSourceIds,
          ["unitOfMeasure", "quantity"]
        );

        const isPr1System = (documentSystem || "").toUpperCase() === "PR1";
        const navSimItems = lineItems.map((item, index) => {
          const sequentialItemNumber = (index + 1) * 10;
          const rawItemDocumentDate = pickValue(item, ["documentDate", "DocumentDate"]);
          const itemDocumentDate = rawItemDocumentDate
            ? normalizeDate(rawItemDocumentDate)
            : headerDocumentDate;
          const normalizedUnitOfMeasure = toStringSafe(
            item.unitOfMeasure || header.dtmUoM
          ).trim();
          const historyLookupKeys = [
            item?.ID,
            item?.itemNumber,
            item?.ItemNumber,
          ]
            .map((value) => toStringSafe(value))
            .filter(Boolean);
          const historyEntry =
            historyLookupKeys
              .map((key) => itemHistoryMap.get(key))
              .find(Boolean) || {};
          const originalUnitOfMeasure = Object.prototype.hasOwnProperty.call(
            historyEntry,
            "unitOfMeasure"
          )
            ? toStringSafe(historyEntry.unitOfMeasure)
            : normalizedUnitOfMeasure;
          const originalQuantity = historyEntry?.quantity !== undefined
            ? toStringSafe(historyEntry.quantity)
            : toStringSafe(item.quantity);
          const changedQuantity = toStringSafe(item.quantity);
          const baseItem = {
            ItemNumber: formatItemNumber(sequentialItemNumber),
            Material: toStringSafe(item.SAPMaterialNo || item.supplierMaterialNumber || item.customerMaterialNumber),
            Quantity: toStringSafe(item.quantity),
            // UnitOfMeasure: convertUoM(item.unitOfMeasure || header.dtmUoM),
            UnitOfMeasure: convertUoM(normalizedUnitOfMeasure, documentSystem),
            DocumentDate: headerDocumentDate,
            DocumentNumber: toStringSafe(item.documentNumber)
          };

          if (!isPr1System) {
            baseItem.ReqDate = itemDocumentDate;
            baseItem.OriginalUnitOfMeasure = convertUoM(originalUnitOfMeasure, documentSystem);
            baseItem.ChangedUnitOfMeasure = convertUoM(normalizedUnitOfMeasure, documentSystem);
            baseItem.OriginalQuantity = originalQuantity;
            baseItem.ChangedQuantity = changedQuantity;
            // baseItem.ManualLineItem = toStringSafe(pickValue(item, ["ManualLineItem", "manualLineItem"]));
          } else {
            const rawDeliveryDate = pickValue(item, [
              "deliveryDate",
              "DeliveryDate",
              "documentDate",
              "DocumentDate"
            ]);
            const rawReqDate = pickValue(item, ["ReqDate", "reqDate", "documentDate", "DocumentDate"]);
            const rawMsDate = pickValue(item, ["MSDate", "msDate"]);
            baseItem.Description = toStringSafe(item.description);
            baseItem.NetAmount = formatAmountValue(item.netAmount);
            baseItem.UnitPrice = formatAmountValue(item.unitPrice);
            baseItem.DeliveryDate = rawDeliveryDate
              ? normalizeDate(rawDeliveryDate)
              : headerReqDate;
            baseItem.CurrencyCode = toStringSafe(item.currencyCode);
            baseItem.SupplierMatNum = toStringSafe(item.supplierMaterialNumber);
            baseItem.CustomerMatNum = toStringSafe(item.customerMaterialNumber);
            baseItem.Plant = toStringSafe(item.Plant);
            baseItem.ItemCategory = toStringSafe(item.ItemCategory);
            baseItem.Route = toStringSafe(item.Route);
            baseItem.ReqDate = rawReqDate ? normalizeDate(rawReqDate) : headerReqDate;
            baseItem.MSDate = rawMsDate ? normalizeDate(rawMsDate) : "";
            baseItem.POItemNumber = toStringSafe(item.extractedItemNumber);
          }

          return baseItem;
        });

        let payload = {
          DocumentNumber: headerDocumentNumber,
          DocumentDate: headerDocumentDate,
          ReqDate: headerReqDate,
          OrderType: toStringSafe(header.dtmOrderType || header.orderType),
          SalesOrg: toStringSafe(header.dtmSalesOrg || header.salesOrg),
          RunType: "Auto",
          DistributionChan: "",
          Division: toStringSafe(header.dtmDivision || ""),
          SenderId: senderId,
          ShipToId: shipToId,
          Training: toStringSafe(document?.training),
          // ShipToAddress: shipToAddress,
          ...emailData,
          LogId: logMetadata.LogId,
          Nav_SimItem: navSimItems,
          Nav_SimReturn: [{}],
          Nav_ItemStat: [{}],
          Nav_HeaderStat: [{}],
        };

        if (isPr1System) {
          pr1Metadata = {
            SendingEmail: toStringSafe(emailData.SendingEmail),
            CCEmail: toStringSafe(logMetadata.CCEmail),
            LogId: toStringSafe(logMetadata.LogId),
            EmailBox: toStringSafe(emailData.EmailBox),
            Training: toStringSafe(document?.training),
          };
          payload.PriceDate = requestPriceDate || normalizeDate(pickValue(header, ["PriceDate", "priceDate", "createdAt", "created_at"]));
          payload.SalesGroup = toStringSafe(pickValue(header, ["salesGroup", "SalesGroup"]));
          payload.PriceGroup = toStringSafe(pickValue(header, ["priceGroup", "PriceGroup"]));
          payload.IncoTerm1 = toStringSafe(pickValue(headerStats, ["incoTerm1", "IncoTerm1"]));
          payload.IncoTerm2 = toStringSafe(pickValue(headerStats, ["incoTerm2", "IncoTerm2"]));
          payload.CurrencyCode = toStringSafe(header.currencyCode);
          payload = enhancePr1SimulatePayload(payload);
          payload = { ...payload, ...pr1Metadata };
        }

        payload.CurrentUser = req.user?.id || req.user?.attr?.email || "";

        return payload;
      };

      const buildPayloadFromRequest = async (data) => {
        const db = await cds.connect.to("db");
        const { DocumentHeaders, DocumentLineItems, Documents } = cds.entities("soautomation");

        const itemsSource = data.Nav_SimItem || [];
        const normalizeItemNumberKey = (value) => {
          const normalized = toStringSafe(value).trim();
          if (!normalized) {
            return "";
          }

          if (/^\d+$/.test(normalized)) {
            return String(Number(normalized));
          }

          return normalized;
        };

        const [headerRecord, lineItemRecords, documentRecord] = await Promise.all([
          data.ID && DocumentHeaders
            ? db.run(
                SELECT.one
                  .from(DocumentHeaders)
                  .columns("deliveryDate", "documentDate", "currencyCode")
                  .where({ documentID_ID: data.ID })
              )
            : null,
          data.ID && DocumentLineItems
            ? db.run(
                SELECT.from(DocumentLineItems)
                  .columns(
                    "ID",
                    "itemNumber",
                    "documentDate",
                    "documentNumber",
                    "unitOfMeasure",
                    "quantity",
                    "extractedItemNumber"
                  )
                  .where({ documentID_ID: data.ID })
              )
            : [],
          data.ID && Documents
            ? db.run(
                SELECT.one
                  .from(Documents)
                  .columns("system", "training")
                  .where({ ID: data.ID })
              )
            : null,
        ]);
        const lineItemDetailsMap = new Map(
          ensureArray(lineItemRecords).flatMap((record) => {
            const entries = [];
            const itemNumberKey = normalizeItemNumberKey(record?.itemNumber);
            const rawItemNumberKey = toStringSafe(record?.itemNumber).trim();

            if (itemNumberKey) {
              entries.push([itemNumberKey, record]);
            }

            if (rawItemNumberKey && rawItemNumberKey !== itemNumberKey) {
              entries.push([rawItemNumberKey, record]);
            }

            return entries;
          })
        );
        const matchedLineItemIds = ensureArray(itemsSource)
          .map((item) => {
            const payloadItemNumber = pickValue(item, ["ItemNumber", "itemNumber"]);
            const lookupKey = normalizeItemNumberKey(payloadItemNumber);
            const matchedLineItem = lineItemDetailsMap.get(lookupKey)
              || lineItemDetailsMap.get(toStringSafe(payloadItemNumber).trim());
            return toStringSafe(matchedLineItem?.ID);
          })
          .filter(Boolean);
        const historySourceIds = [...new Set(matchedLineItemIds)];
        const itemHistoryMap = await fetchItemHistoryMap(data.ID, historySourceIds, [
          "unitOfMeasure",
          "quantity",
        ]);

        documentSystem = documentSystem || documentRecord?.system || null;

        const rawHeaderDocumentDate = pickValue(data, ["DocumentDate", "documentDate"]);
        const headerDocumentDate = rawHeaderDocumentDate ? normalizeDate(rawHeaderDocumentDate) : "";
        const [emailData, logMetadata] = await Promise.all([
          fetchDocumentEmails(data.ID),
          fetchDocumentLogMetadata(data.ID),
        ]);
        const systemCode = (documentSystem || data?.system || "").toUpperCase();
        const isPr1Request = systemCode === "PR1";
        const rawHeaderReqDate = isPr1Request
          ? pickValue(data, ["ReqDate", "reqDate"])
          : pickValue(data, ["deliveryDate", "DeliveryDate"]);
        const headerReqDate = rawHeaderReqDate ? normalizeDate(rawHeaderReqDate) : "";
        const items = ensureArray(itemsSource).map((item, index) => {
          const sequentialItemNumber = (index + 1) * 10;
          const payloadItemNumber = pickValue(item, ["ItemNumber", "itemNumber"]);
          const rawItemDocumentDate = pickValue(item, ["DocumentDate", "documentDate"]);
          const itemDocumentDate = rawItemDocumentDate ? normalizeDate(rawItemDocumentDate) : ""; 
          const itemDocumentNumber = pickValue(item, ["DocumentNumber", "documentNumber"]);
          const lineItemNumberKey = normalizeItemNumberKey(payloadItemNumber);
          const dbLineItem = lineItemDetailsMap.get(lineItemNumberKey)
            || lineItemDetailsMap.get(toStringSafe(payloadItemNumber).trim())
            || {};
          const historyEntry = itemHistoryMap.get(toStringSafe(dbLineItem?.ID)) || {};
          const changedUnitOfMeasure = toStringSafe(
            item?.UnitOfMeasure || dbLineItem?.unitOfMeasure
          );
          const originalUnitOfMeasure = Object.prototype.hasOwnProperty.call(
            historyEntry,
            "unitOfMeasure"
          )
            ? toStringSafe(historyEntry.unitOfMeasure)
            : toStringSafe(dbLineItem?.unitOfMeasure);
          const originalQuantity = historyEntry?.quantity !== undefined
            ? toStringSafe(historyEntry.quantity)
            : toStringSafe(dbLineItem?.quantity);
          const changedQuantity = toStringSafe(item?.Quantity ?? dbLineItem?.quantity);

          const baseItem = {
            ItemNumber: toStringSafe(payloadItemNumber) || formatItemNumber(sequentialItemNumber),
            Material: toStringSafe(item?.Material),
            Quantity: toStringSafe(item?.Quantity),
            UnitOfMeasure: toStringSafe(item?.UnitOfMeasure),
            DocumentDate: headerDocumentDate,
            DocumentNumber: toStringSafe(itemDocumentNumber),
          };

          if (!isPr1Request) {
            baseItem.ReqDate = itemDocumentDate ? normalizeDate(itemDocumentDate) : "";
            baseItem.ManualLineItem = toStringSafe(pickValue(item, ["ManualLineItem", "manualLineItem"]));
            baseItem.OriginalUnitOfMeasure = convertUoM(originalUnitOfMeasure, documentSystem);
            baseItem.ChangedUnitOfMeasure = convertUoM(changedUnitOfMeasure, documentSystem);
            baseItem.OriginalQuantity = originalQuantity;
            baseItem.ChangedQuantity = changedQuantity;
          }

          if (isPr1Request) {
            const rawItemDeliveryDate = pickValue(item, ["DeliveryDate", "ReqDate", "deliveryDate"]);
            const rawItemReqDate = pickValue(item, ["ReqDate", "reqDate"]);
            const rawItemMsDate = pickValue(item, ["MSDate", "msDate"]);
            baseItem.Description = toStringSafe(pickValue(item, ["Description", "description"]));
            baseItem.NetAmount = toStringSafe(pickValue(item, ["NetAmount", "netAmount"]));
            baseItem.UnitPrice = toStringSafe(pickValue(item, ["UnitPrice", "unitPrice"]));
            baseItem.DeliveryDate = rawItemDeliveryDate ? normalizeDate(rawItemDeliveryDate) : null;
            baseItem.CurrencyCode = toStringSafe(pickValue(item, ["CurrencyCode", "currencyCode"]));
            baseItem.SupplierMatNum = toStringSafe(pickValue(item, ["SupplierMatNum", "supplierMatNum"]));
            baseItem.CustomerMatNum = toStringSafe(pickValue(item, ["CustomerMatNum", "customerMatNum"]));
            baseItem.Kdmat = item ? toStringSafe(pickValue(item, ["kdmat", "Kdmat", "Kmdat", "kmdat"])) : "";
            baseItem.Plant = toStringSafe(pickValue(item, ["Plant", "plant"]));
            baseItem.ItemCategory = toStringSafe(pickValue(item, ["ItemCategory", "itemCategory"]));
            baseItem.Route = toStringSafe(pickValue(item, ["Route", "route"]));
            baseItem.ReqDate = rawItemReqDate ? normalizeDate(rawItemReqDate) : "";
            baseItem.MSDate = rawItemMsDate ? normalizeDate(rawItemMsDate) : "";
            baseItem.POItemNumber = toStringSafe(dbLineItem.extractedItemNumber);
            // baseItem.Kdkg1 = toStringSafe(pickValue(item, ["Kdkgl", "kdkgl", "kdkg1", "Kdkg1"]));
          }

          return baseItem;
        });

        let payload = {
          DocumentNumber: toStringSafe(data.DocumentNumber),
          DocumentDate: headerDocumentDate,
          ReqDate: headerReqDate,
          OrderType: toStringSafe(data.OrderType),
          SalesOrg: toStringSafe(data.SalesOrg),
          RunType: "Manual",
          DistributionChan: toStringSafe(data.DistributionChan),
          Division: toStringSafe(data.Division),
          SenderId: toStringSafe(data.SenderId),
          ShipToId: toStringSafe(data.ShipToId),
          Training: toStringSafe(documentRecord?.training),
          // ShipToAddress: toStringSafe(data.ShipToAddress),
          ...emailData,
          LogId: logMetadata.LogId,
          Nav_SimItem: items,
          Nav_SimReturn: [{}],
          Nav_ItemStat: [{}],
          Nav_HeaderStat: [{}],
        };

        if (isPr1Request) {
          pr1Metadata = {
            SendingEmail: toStringSafe(emailData.SendingEmail),
            CCEmail: toStringSafe(logMetadata.CCEmail),
            LogId: toStringSafe(logMetadata.LogId),
            EmailBox: toStringSafe(emailData.EmailBox),
            Training: toStringSafe(documentRecord?.training),
          };
          documentSystem = documentSystem || data?.system || 'PR1';
          payload.PriceDate = normalizeDate(
            pickValue(data, ["PriceDate", "priceDate"])
          );
          payload.SalesOrg = toStringSafe(data.SalesOrg)?.split(" - ")[0] || "";
          if (data.Nav_PriceSim) {
            payload.Nav_PriceSim = data.Nav_PriceSim;
          }
          if (data.Nav_SimText) {
            payload.Nav_SimText = data.Nav_SimText;
          }
          if (data.Nav_SimuAddPriceCond) {
            payload.Nav_SimuAddPriceCond = data.Nav_SimuAddPriceCond;
          }
          if (data.Nav_SimuCreateText) {
            payload.Nav_SimuCreateText = data.Nav_SimuCreateText;
          }
          payload.SalesGroup = toStringSafe(
            pickValue(data, ["SalesGroup", "salesGroup"])
          );
          payload.PriceGroup = toStringSafe(
            pickValue(data, ["PriceGroup", "priceGroup"])
          );
          payload.IncoTerm1 = toStringSafe(
            pickValue(data, ["IncoTerm1", "incoTerm1"])
          );
          payload.IncoTerm2 = toStringSafe(
            pickValue(data, ["IncoTerm2", "incoTerm2"])
          );
          payload.CurrencyCode = toStringSafe(pickValue(data, ["CurrencyCode", "currencyCode"])) || toStringSafe(headerRecord?.currencyCode);
          payload = enhancePr1SimulatePayload(payload);
          payload = { ...payload, ...pr1Metadata };
        }

        payload.CurrentUser = req.user?.id || req.user?.attr?.email || "";

        return payload;
      };

      let payload;

      if (attachmentId && instanceId) {
        payload = await buildPayloadFromDb(attachmentId, instanceId);
        if (!payload) {
          return;
        }
      } else {
        // payload = buildPayloadFromRequest(requestData);
        payload = await buildPayloadFromRequest(requestData);
      }

      documentSystem = documentSystem || requestData?.system || null;

      const externalService = await cds.connect.to("ZSD_SOA_SRV");
      adjustZsdServiceForSystem(externalService, payload, documentSystem);
      applyHardcodedTestUser(payload, documentSystem);
      const result = await externalService.tx(req).post("/SimulateSOs", payload);
      const payloadFromDb = Boolean(attachmentId && instanceId);
      await persistSimulateResult(
        result,
        {
          payloadFromDb,
          documentIdForLogs,
          documentSystem,
        }
      );

      if(documentSystem?.toUpperCase() === "PR1"){
        if (extractResultStatus(result) === "SUCCESS") {
          const taskId = pickValue(result, ["TaskID", "TaskId", "taskID", "taskId"]);
          const deleteResult = await deleteTaskId(taskId, externalService, req);
        }
      }

      return result;
    } catch (error) {
      req.error(400, "Error to Simulate SO | " + error.message);
    }
  });

  srv.on("oDataCreateSOs", async (req) => {
    const requestData = req.data || {};
    const requestPriceDate = normalizeDate(
      pickValue(requestData, ["PriceDate", "priceDate"])
    );
    let documentIdForLogs = null;
    try {
      const { attachmentId, instanceId } = requestData;
      const individualCreation = parseBooleanFlag(requestData.individualCreation);
      let lineItemsForUpdate = [];
      let documentSystem = null;
      let pr1Metadata = null;

      const fetchHeaderOriginalValues = async (
        documentId,
        {
          headerStatsFallback = {},
          requestFallback = {},
          mode = "db",
        } = {}
      ) => {
        const entities = cds.entities("soautomation") || {};
        const { DocumentFieldHistories, DocumentHeaderStats } = entities;

        if (!documentId) {
          return {
            originalSenderId:
              mode === "request" ? toStringSafe(requestFallback?.senderId) : "",
            originalShipToId:
              mode === "request" ? toStringSafe(requestFallback?.shipToId) : "",
          };
        }

        const db = await cds.connect.to("db");

        // Oldest row wins so originalValue reflects the first tracked change.
        const historyRecords = DocumentFieldHistories
          ? await db.run(
              SELECT.from(DocumentFieldHistories)
                .columns("fieldName", "originalValue", "createdAt")
                .where({
                  documentID_ID: documentId,
                  fieldName: { in: ["shipToId", "soldToId"] },
                })
                .orderBy("createdAt asc")
            )
          : [];

        const historyMap = new Map();
        ensureArray(historyRecords).forEach((record) => {
          if (historyMap.has(record.fieldName)) return;
          historyMap.set(record.fieldName, toStringSafe(record.originalValue));
        });

        const hasHeaderStatsFallback =
          Object.keys(headerStatsFallback || {}).length > 0;
        const shouldUseHeaderStatsFallback =
          mode === "request"
            ? hasHeaderStatsFallback || !!DocumentHeaderStats
            : !!DocumentHeaderStats;
        const headerStatsRecord = shouldUseHeaderStatsFallback
          ? hasHeaderStatsFallback
            ? headerStatsFallback
            : DocumentHeaderStats
            ? await db.run(
                SELECT.one
                  .from(DocumentHeaderStats)
                  .columns("shipToId", "soldToId")
                  .where({ documentID_ID: documentId })
              )
            : {}
          : {};

        const currentShipToId = toStringSafe(requestFallback?.shipToId);
        const currentSenderId = toStringSafe(requestFallback?.senderId);
        const shipToFromStats = toStringSafe(headerStatsRecord?.shipToId);
        const soldToFromStats = toStringSafe(headerStatsRecord?.soldToId);

        const deriveOriginalValue = (fieldName, currentValue, statsValue) => {
          const historyValue = historyMap.get(fieldName);
          if (historyValue !== undefined) {
            return toStringSafe(historyValue);
          }

          if (statsValue !== undefined && statsValue !== null && statsValue !== "") {
            return toStringSafe(statsValue);
          }

          return "";
        };

        return {
          originalSenderId: deriveOriginalValue(
            "soldToId",
            currentSenderId,
            soldToFromStats
          ),
          originalShipToId: deriveOriginalValue(
            "shipToId",
            currentShipToId,
            shipToFromStats
          ),
        };
      };

      const buildNavAttach = (documentRecord) => [
        {
          DocumentID: toStringSafe(documentRecord?.attachmentId),
          FileName: toStringSafe(documentRecord?.fileName),
          FileData: "",
        },
      ];

      if ((attachmentId && !instanceId) || (!attachmentId && instanceId)) {
        req.error(400, "attachmentId and instanceId must be provided together");
        return;
      }

      const buildPayloadFromDb = async (attId, instId) => {
        const documentData = await fetchDocumentForOData(attId, instId, req);
        if (!documentData) {
          return null;
        }

        const { header, headerStats, lineItems, documentId, document } = documentData;
        documentIdForLogs = documentId;
        documentSystem = document?.system || null;

        const db = await cds.connect.to("db");
        const { Documents: DocsEntity } = cds.entities("soautomation") || {};
        const docRecord = DocsEntity
          ? await db.run(SELECT.one.from(DocsEntity).columns("status").where({ ID: documentId }))
          : null;

        const activeLineItems = applyDuplicateCreationGuard(
          req,
          docRecord?.status,
          lineItems,
          item => !toStringSafe(item.SalesOrder).trim()
        );
        if (!activeLineItems) return null;

        lineItemsForUpdate = activeLineItems;
        const itemSourceIds = ensureArray(activeLineItems)
          .map((item) => item?.itemNumber ?? item?.ID)
          .filter(Boolean);
        const [headerOriginals, itemHistoryMap] = await Promise.all([
          fetchHeaderOriginalValues(documentIdForLogs, { headerStatsFallback: headerStats }),
          fetchItemHistoryMap(documentIdForLogs, itemSourceIds),
        ]);
        const [emailData, logMetadata] = await Promise.all([
          fetchDocumentEmails(documentId),
          fetchDocumentLogMetadata(documentId),
        ]);
        // const headerDocumentDate = normalizeDate(header.documentDate) || normalizeDate(header.createdAt);
        const headerDocumentDate = normalizeDate(header.createdAt);
        const headerReqDate = normalizeDate(header.deliveryDate);
        const headerDocumentNumber = toStringSafe(header.documentNumber);
        const senderId = toStringSafe(headerStats?.soldToId);
        const shipToId = toStringSafe(headerStats?.shipToId);
        const isPr1 = (document?.system || "").toUpperCase() === "PR1";
        // const shipToAddress = toStringSafe(headerStats?.shipToAddress);
        const shipToAddress = toStringSafe(header?.shipToAddress);
        const navItems = activeLineItems.map((item, index) => {
          const rawItemDocumentDate = pickValue(item, ["documentDate", "DocumentDate"]);
          const itemDocumentDate = rawItemDocumentDate
            ? normalizeDate(rawItemDocumentDate)
            : headerDocumentDate;
          const itemDeliveryDate = isPr1
            ? normalizeDate(rawItemDocumentDate) || headerReqDate || ""
            : "";
          const itemReqDate = isPr1
            ? normalizeDate(item.ConfDelDate) || headerReqDate || ""
            : itemDocumentDate;
          const itemMsDate = isPr1
            ? normalizeDate(pickValue(item, ["MSDate", "msDate"])) || ""
            : "";
          const sequentialItemNumber = (index + 1) * 10;
          const lineItemSourceId = toStringSafe(item?.itemNumber ?? item?.ID);
          const historyEntry = itemHistoryMap.get(lineItemSourceId) || {};
          const originalMaterial = historyEntry?.SAPMaterialNo ?? item.SAPMaterialNo;
          const originalUnitOfMeasure = Object.prototype.hasOwnProperty.call(
            historyEntry,
            "unitOfMeasure"
          )
            ? toStringSafe(historyEntry.unitOfMeasure)
            : toStringSafe(item.unitOfMeasure);
          const customerMaterialNumber = item.customerMaterialNumber;
          const originalCustomerMaterialNumber =
            historyEntry?.customerMaterialNumber ?? customerMaterialNumber;
          const originalQuantity =
            historyEntry?.quantity !== undefined
              ? toStringSafe(historyEntry.quantity)
              : toStringSafe(item.quantity);
          const changedQuantity = toStringSafe(item.quantity);
          return {
            ItemNumber: formatItemNumber(sequentialItemNumber),
            Material: toStringSafe(item.SAPMaterialNo || item.customerMaterialNumber),
            Quantity: toStringSafe(item.SAPQuantity || item.quantity),
            UnitOfMeasure: convertUoM(item.SAPUnitOfMeasure || header.dtmUoM, document?.system),
            ShipType: toStringSafe(item.shippingType),
            OriginalUnitOfMeasure: convertUoM(originalUnitOfMeasure, document?.system),
            ChangedUnitOfMeasure: convertUoM(item.unitOfMeasure, document?.system),
            DocumentDate: headerDocumentDate,
            ReqDate: itemReqDate,
            ...(isPr1
              ? {
                DeliveryDate: itemDeliveryDate,
                MSDate: itemMsDate,
                CurrencyCode: toStringSafe(item.currencyCode),
                POItemNumber: toStringSafe(item.extractedItemNumber),
              }
              : {}),
            OriginalMaterial: toStringSafe(originalMaterial),
            CustomerMaterialNumber: toStringSafe(customerMaterialNumber),
            OriginalCustomerMaterialNumber: toStringSafe(
              originalCustomerMaterialNumber
            ),
            CustomerMaterialDesc: toStringSafe(item.description),
            DocumentNumber: toStringSafe(item.DocumentNumber ?? headerDocumentNumber),
            ...(!isPr1
              ? {
                ChangedQuantity: changedQuantity,
                OriginalQuantity: originalQuantity,
              }
              : {}),
          };
        });

        if (isPr1) {
          pr1Metadata = {
            SendingEmail: toStringSafe(emailData.SendingEmail),
            CCEmail: toStringSafe(logMetadata.CCEmail),
            LogId: toStringSafe(logMetadata.LogId),
            EmailBox: toStringSafe(emailData.EmailBox),
            Training: toStringSafe(document?.training),
          };
        }

        return {
          DocumentNumber: headerDocumentNumber,
          DocumentDate: headerDocumentDate,
          ReqDate: headerReqDate,
          OrderType: toStringSafe(header.dtmOrderType || header.orderType),
          SalesOrg: toStringSafe(header.dtmSalesOrg || header.salesOrg),
          RunType: "Auto",
          DistributionChan: toStringSafe(
            header.dtmDistributionChan || header.distributionChan || header.distributionChannel
          ),
          Division: toStringSafe(header.dtmDivision || header.division),
          SenderId: senderId,
          OriginalSenderId: headerOriginals.originalSenderId,
          ShipToId: shipToId,
          OriginalShipToId: headerOriginals.originalShipToId,
          ShipToAddress: shipToAddress,
          Training: toStringSafe(document?.training),
          ...(!isPr1
            ? {
              NetAmount: formatAmountValue(header.netAmount),
              CurrencyCode: toStringSafe(header?.currencyCode),
            }
            : {}),
          ...(isPr1
            ? {
              CurrencyCode: toStringSafe(header.currencyCode),
              SalesGroup: toStringSafe(pickValue(header, ["salesGroup", "SalesGroup"])),
              PriceGroup: toStringSafe(pickValue(header, ["priceGroup", "PriceGroup"])),
              IncoTerm1: toStringSafe(
                pickValue(headerStats, ["incoTerm1", "IncoTerm1"])
              ),
              IncoTerm2: toStringSafe(
                pickValue(headerStats, ["incoTerm2", "IncoTerm2"])
              ),
              BillToId: toStringSafe(pickValue(headerStats, ["billToId", "BillToId"])),
              PayerId: toStringSafe(pickValue(headerStats, ["payerId", "PayerId"])),
              ContactPersonId: toStringSafe(
                pickValue(header, ["contactPersonId", "ContactPersonId"])
              ),
              ContactPersonId_Dino: toStringSafe(
                pickValue(header, ["contactPersonId_Dino", "ContactPersonId_Dino"])
              ),
              ContactPersonId_Inv: toStringSafe(
                pickValue(header, ["contactPersonId_Inv", "ContactPersonId_Inv"])
              ),
              ContactPersonId_MSDS: toStringSafe(
                pickValue(header, ["contactPersonId_MSDS", "ContactPersonId_MSDS"])
              ),
              SalesRepresentativeId: toStringSafe(
                pickValue(header, ["salesRepresentativeId", "SalesRepresentativeId"])
              ),
            }
            : {}),
          ...emailData,
          LogId: logMetadata.LogId,
          CCEmail: logMetadata.CCEmail,
          Nav_Item: navItems,
          Nav_Attach: buildNavAttach(document),
          Nav_Return: [{}],
          Nav_ItemStat: [{}],
          Nav_HeaderStat: [{}],
          CurrentUser: req.user?.id || req.user?.attr?.email || "",
          ...(isPr1 ? pr1Metadata : {}),
          ...(isPr1
            ? {
              PriceDate:
                requestPriceDate ||
                headerPriceDate,
            }
            : {}),
        };
      };

      const buildPayloadFromRequest = async (data) => {
        // const headerDocumentDate = normalizeDate(data.DocumentDate);
        // Inicio - fix de obtener el ReqDate para los headers y los items 
        const db = await cds.connect.to("db");
        const { Documents, DocumentHeaders, DocumentLineItems, DocumentHeaderStats } =
          cds.entities("soautomation");
        const hasMeaningfulValue = (entry = {}) =>
          Object.values(entry).some((value) => value !== "");

        const buildPr1NavCreateAddPriceCond = (items = []) =>
          ensureArray(items)
            .map((item) => ({
              ItemNumber: toStringSafe(pickValue(item, ["ItemNumber", "itemNumber"])),
              CondType: toStringSafe(pickValue(item, ["CondType", "condType"])),
              CondValue: toStringSafe(pickValue(item, ["CondValue", "condValue"])),
              Currency: toStringSafe(pickValue(item, ["Currency", "currency"])),
            }))
            .filter(hasMeaningfulValue);

        const buildPr1NavCreateText = (items = []) =>
          ensureArray(items)
            .map((item) => ({
              ItemNumber: toStringSafe(pickValue(item, ["ItemNumber", "itemNumber"])),
              TextId: toStringSafe(pickValue(item, ["TextId", "textId"])),
              Langu: toStringSafe(pickValue(item, ["Langu", "langu"])),
              TextLine: toStringSafe(pickValue(item, ["TextLine", "textLine"])),
            }))
            .filter(hasMeaningfulValue);

        let itemsSource = data.Nav_Item || [];
        const navCreAddPriceCond = buildPr1NavCreateAddPriceCond(
          data.Nav_CreAddPriceCond
        );
        const navCreateText = buildPr1NavCreateText(data.Nav_CreateText);
        const itemIds = ensureArray(itemsSource)
          .map((item) => item?.ID)
          .filter(Boolean);
        const itemSourceIds = ensureArray(itemsSource)
          .map((item) => item?.itemNumber ?? item?.ID)
          .filter(Boolean);

        const [headerRecord, headerStatsRecord, lineItemRecords, documentRecord] = await Promise.all([
          data.ID && DocumentHeaders
            ? db.run(
                SELECT.one
                  .from(DocumentHeaders)
                  .columns("deliveryDate", "documentDate", "shipToAddress", "netAmount", "currencyCode")
                  .where({ documentID_ID: data.ID })
              )
            : null,
          data.ID && DocumentHeaderStats
            ? db.run(
                SELECT.one
                  .from(DocumentHeaderStats)
                  .columns("shipToId", "soldToId", "shipToAddress")
                  .where({ documentID_ID: data.ID })
              )
            : null,
          itemIds.length > 0 && DocumentLineItems
            ? db.run(
                SELECT.from(DocumentLineItems)
                  .columns(
                    "ID",
                    "documentDate",
                    "ConfDelDate",
                    "SalesOrder",
                    "SAPMaterialNo",
                    "customerMaterialNumber",
                    "itemNumber",
                    "unitOfMeasure",
                    "description",
                    "shippingType",
                    "SAPUnitOfMeasure",
                    "documentNumber",
                    "quantity",
                    "extractedItemNumber"
                  )
                  .where({ ID: { in: itemIds } })
              )
            : [],
          data.ID && Documents
            ? db.run(
                SELECT.one
                  .from(Documents)
                  .columns("attachmentId", "fileName", "system", "training", "status")
                  .where({ ID: data.ID })
              )
            : null,
        ]);

        if (data.ID) {
          const createdKeys = new Set();
          ensureArray(lineItemRecords).forEach(r => {
            if (toStringSafe(r.SalesOrder).trim()) {
              if (r.ID) createdKeys.add(toStringSafe(r.ID));
              if (r.itemNumber !== null && r.itemNumber !== undefined) {
                createdKeys.add(toStringSafe(r.itemNumber));
              }
            }
          });

          const activeItemsSource = applyDuplicateCreationGuard(
            req,
            documentRecord?.status,
            ensureArray(itemsSource),
            item => {
              const id = toStringSafe(item?.ID);
              const num = toStringSafe(item?.itemNumber ?? item?.ItemNumber);
              return (!id || !createdKeys.has(id)) && (!num || !createdKeys.has(num));
            }
          );
          if (!activeItemsSource) return null;

          itemsSource = activeItemsSource;
        }

        documentSystem = documentSystem || documentRecord?.system || data?.system || null;
        const isPr1 = (documentSystem || "").toUpperCase() === "PR1";

        const [headerOriginals, itemHistoryMap] = await Promise.all([
          fetchHeaderOriginalValues(data.ID, {
            headerStatsFallback: headerStatsRecord,
            requestFallback: { shipToId: data.ShipToId, senderId: data.SenderId },
            mode: "request",
          }),
          fetchItemHistoryMap(data.ID, itemSourceIds),
        ]);

        const lineItemsDateMap = new Map(
          ensureArray(lineItemRecords).flatMap((record) => {
            const entries = [];
            const idKey = toStringSafe(record.ID);
            const itemNumberKey =
              record.itemNumber !== undefined && record.itemNumber !== null
                ? toStringSafe(record.itemNumber)
                : null;

            if (idKey) {
              entries.push([idKey, normalizeDate(record.documentDate)]);
            }

            if (itemNumberKey) {
              entries.push([itemNumberKey, normalizeDate(record.documentDate)]);
            }

            return entries;
          })
        );

        const lineItemDetailsMap = new Map(
          ensureArray(lineItemRecords).flatMap((record) => {
            const entries = [];
            const idKey = toStringSafe(record.ID);
            const itemNumberKey =
              record.itemNumber !== undefined && record.itemNumber !== null
                ? toStringSafe(record.itemNumber)
                : null;

            if (idKey) {
              entries.push([idKey, record]);
            }

            if (itemNumberKey) {
              entries.push([itemNumberKey, record]);
            }

            return entries;
          })
        );
        // Fix - 30/12/2025 - Fix DeliveryDate en vez de PO Date en el payload del CreateSOs
        const rawHeaderDocumentDate = pickValue(data, ["DocumentDate", "documentDate"]);
        const headerDocumentDate = rawHeaderDocumentDate ? normalizeDate(rawHeaderDocumentDate) : "";
        const rawHeaderReqDate = pickValue(data, ["deliveryDate", "DeliveryDate"]);
        const headerReqDate = isPr1
          ? normalizeDate(headerRecord?.deliveryDate) || normalizeDate(rawHeaderReqDate)
          : rawHeaderReqDate
            ? normalizeDate(rawHeaderReqDate)
            : "";
        // Fin fix - 30/12/2025 - Fix DeliveryDate en vez de PO Date en el payload del CreateSOs
        const [emailData, logMetadata] = await Promise.all([
          fetchDocumentEmails(data.ID),
          fetchDocumentLogMetadata(data.ID),
        ]);
        // const itemsSource = data.Nav_Item || data.Nav_SimItem || [];
        lineItemsForUpdate = ensureArray(itemsSource);
        const items = ensureArray(itemsSource).map((item, index) => {
          const sequentialItemNumber = (index + 1) * 10;
          const payloadItemNumber = pickValue(item, ["ItemNumber", "itemNumber"]);
          // Fix - 30/12/2025 - Fix DeliveryDate en el payload del CreateSOs
          const rawItemDocumentDate = pickValue(item, ["DocumentDate", "documentDate"]);
          const itemDocumentDate = rawItemDocumentDate ? normalizeDate(rawItemDocumentDate) : "";
          // Fin fix - 30/12/2025 - Fix DeliveryDate en el payload del CreateSOs
          const lineItemSourceId = toStringSafe(item?.itemNumber ?? item?.ID);
          const dbLineItem = lineItemDetailsMap.get(lineItemSourceId) || {};
          const historyEntry = itemHistoryMap.get(lineItemSourceId) || {};
          const payloadCustomerMaterialNumber = toStringSafe(item?.CustomerMatNum);
          const storedCustomerMaterialNumber = toStringSafe(
            dbLineItem.customerMaterialNumber
          );
          const customerMaterialNumber =
            payloadCustomerMaterialNumber &&
            payloadCustomerMaterialNumber !== storedCustomerMaterialNumber
              ? payloadCustomerMaterialNumber
              : storedCustomerMaterialNumber;
          const storedMaterial = toStringSafe(dbLineItem.SAPMaterialNo);
          const originalMaterial = historyEntry?.SAPMaterialNo !== undefined
            ? toStringSafe(historyEntry.SAPMaterialNo)
            : storedMaterial;
          const originalCustomerMaterialNumber = historyEntry?.customerMaterialNumber !== undefined
            ? toStringSafe(historyEntry.customerMaterialNumber)
            : toStringSafe(storedCustomerMaterialNumber);
          const originalUnitOfMeasure = Object.prototype.hasOwnProperty.call(
            historyEntry,
            "unitOfMeasure"
          )
            ? toStringSafe(historyEntry.unitOfMeasure)
            : toStringSafe(dbLineItem.unitOfMeasure);
          const originalQuantity = historyEntry?.quantity !== undefined ? toStringSafe(historyEntry.quantity) : toStringSafe(dbLineItem.quantity);
          const changedQuantity = toStringSafe(dbLineItem.quantity);
          const rawItemDeliveryDate = pickValue(item, ["DeliveryDate", "deliveryDate"]);
          const rawItemReqDate = pickValue(item, ["ReqDate", "reqDate"]);
          const rawItemMsDate = pickValue(item, ["MSDate", "msDate"]);
          const itemDeliveryDate = isPr1
            ? normalizeDate(rawItemDeliveryDate)
              || normalizeDate(dbLineItem?.documentDate)
              || headerReqDate
              || ""
            : "";
          const itemReqDate = isPr1
            ? normalizeDate(rawItemReqDate)
              || normalizeDate(dbLineItem?.ConfDelDate)
              || headerReqDate
              || ""
            : itemDocumentDate;
          const itemMsDate = isPr1
            ? normalizeDate(rawItemMsDate) || normalizeDate(dbLineItem?.MSDate) || ""
            : "";
          return {
            ItemNumber: toStringSafe(payloadItemNumber) || formatItemNumber(sequentialItemNumber),
            Material: toStringSafe(item?.Material),
            Quantity: toStringSafe(item?.Quantity),
            UnitOfMeasure: toStringSafe(item?.UnitOfMeasure || dbLineItem?.SAPUnitOfMeasure),
            ChangedUnitOfMeasure: toStringSafe(dbLineItem?.unitOfMeasure),
            ShipType: toStringSafe(dbLineItem?.shippingType),
            OriginalUnitOfMeasure: originalUnitOfMeasure,
            DocumentDate: headerDocumentDate,
            ReqDate: itemReqDate,
            ...(isPr1
              ? {
                DeliveryDate: itemDeliveryDate,
                MSDate: itemMsDate,
              }
              : {}),
            OriginalMaterial: toStringSafe(originalMaterial),
            CustomerMaterialNumber: toStringSafe(customerMaterialNumber),
            OriginalCustomerMaterialNumber: toStringSafe(
              originalCustomerMaterialNumber
            ),
            CustomerMaterialDesc: toStringSafe(dbLineItem?.description ?? item?.description),
            DocumentNumber: toStringSafe(item.DocumentNumber ?? dbLineItem.DocumentNumber),
            ...(!isPr1 ? {
              ManualLineItem: toStringSafe(pickValue(item, ["ManualLineItem", "manualLineItem"])),
              ChangedQuantity: changedQuantity,
              OriginalQuantity: originalQuantity,
            } : {}),
            ...(isPr1
              ? {
                CurrencyCode: toStringSafe(pickValue(item, ["CurrencyCode", "currencyCode"])) || toStringSafe(dbLineItem.currencyCode),
                Plant: toStringSafe(pickValue(item, ["Plant", "plant"])),
                ItemCategory: toStringSafe(
                  pickValue(item, ["ItemCategory", "itemCategory"])
                ),
                Route: toStringSafe(pickValue(item, ["Route", "route"])),
                Kdmat: item
                  ? toStringSafe(
                      pickValue(item, ["Kdmat", "kdmat", "Kmdat", "kmdat"])
                    )
                  : "",
                Kdkg1: toStringSafe(pickValue(item, ["Kdkgl", "kdkgl", "kdkg1", "Kdkg1"])),
                POItemNumber: toStringSafe(dbLineItem.extractedItemNumber),
              }
              : {}),
          };
        });

        if (isPr1) {
          pr1Metadata = {
            SendingEmail: toStringSafe(emailData.SendingEmail),
            CCEmail: toStringSafe(logMetadata.CCEmail),
            LogId: toStringSafe(logMetadata.LogId),
            EmailBox: toStringSafe(emailData.EmailBox),
            Training: toStringSafe(documentRecord?.training),
          };
        }

        return {
          DocumentNumber: toStringSafe(data.DocumentNumber),
          DocumentDate: headerDocumentDate,
          ReqDate: headerReqDate,
          OrderType: toStringSafe(data.OrderType),
          SalesOrg: toStringSafe(data.SalesOrg),
          RunType: "Manual",
          DistributionChan: toStringSafe(data.DistributionChan),
          Division: toStringSafe(data.Division),
          SenderId: toStringSafe(data.SenderId),
          OriginalSenderId: headerOriginals.originalSenderId,
          ShipToId: toStringSafe(data.ShipToId),
          OriginalShipToId: headerOriginals.originalShipToId,
          ShipToAddress: toStringSafe(headerRecord?.shipToAddress),
          Training: toStringSafe(documentRecord?.training),
          ...(!isPr1
            ? {
              NetAmount: formatAmountValue(headerRecord?.netAmount),
              CurrencyCode: toStringSafe(headerRecord?.currencyCode),
            }
            : {}),
          ...(isPr1
            ? {
              CurrencyCode: toStringSafe(pickValue(data, ["CurrencyCode", "currencyCode"])) || toStringSafe(headerRecord?.currencyCode),
              Dlv_Block: toStringSafe(
                pickValue(data, ["Dlv_Block", "dlvBlock", "dlv_block"])
              ),
              SalesGroup: toStringSafe(
                pickValue(data, ["SalesGroup", "salesGroup"])
              ),
              PriceGroup: toStringSafe(
                pickValue(data, ["PriceGroup", "priceGroup"])
              ),
              IncoTerm1: toStringSafe(
                pickValue(data, ["IncoTerm1", "incoTerm1"])
              ),
              IncoTerm2: toStringSafe(
                pickValue(data, ["IncoTerm2", "incoTerm2"])
              ),
              BillToId: toStringSafe(pickValue(data, ["BillToId", "billToId"])),
              PayerId: toStringSafe(pickValue(data, ["PayerId", "payerId"])),
              ContactPersonId: toStringSafe(
                pickValue(data, ["ContactPersonId", "contactPersonId"])
              ),
              ContactPersonId_CoA: toStringSafe(
                pickValue(data, ["ContactPersonId_CoA", "contactPersonId_CoA"])
              ),
              ContactPersonId_Dino: toStringSafe(
                pickValue(data, ["ContactPersonId_Dino", "contactPersonId_Dino"])
              ),
              ContactPersonId_Inv: toStringSafe(
                pickValue(data, ["ContactPersonId_Inv", "contactPersonId_Inv"])
              ),
              ContactPersonId_MSDS: toStringSafe(
                pickValue(data, ["ContactPersonId_MSDS", "contactPersonId_MSDS"])
              ),
              SalesRepresentativeId: toStringSafe(
                pickValue(data, [
                  "SalesRepresentativeId",
                  "salesRepresentativeId",
                ])
              ),
            }
            : {}),
          ...emailData,
          LogId: logMetadata.LogId,
          CCEmail: logMetadata.CCEmail,
          Nav_Item: items,
          Nav_Attach: buildNavAttach(documentRecord),
          Nav_Return: [{}],
          Nav_ItemStat: [{}],
          Nav_HeaderStat: [{}],
          CurrentUser: req.user?.id || req.user?.attr?.email || "",
          ...(isPr1 ? pr1Metadata : {}),
          ...(isPr1 && navCreAddPriceCond.length > 0
            ? { Nav_CreAddPriceCond: navCreAddPriceCond }
            : {}),
          ...(isPr1 && navCreateText.length > 0
            ? { Nav_CreateText: navCreateText }
            : {}),
          ...(isPr1
            ? {
              PriceDate: normalizeDate(pickValue(data, ["PriceDate", "priceDate"])),
            }
            : {}),
        };
      };

      let payload;
      if (attachmentId && instanceId) {
        payload = await buildPayloadFromDb(attachmentId, instanceId);
        if (!payload) {
          return;
        }
      } else {
        // payload = buildPayloadFromRequest(requestData);
        payload = await buildPayloadFromRequest(requestData);
        if (!payload) {
          return;
        }
      }

      documentSystem = documentSystem || requestData?.system || null;

      const externalService = await cds.connect.to("ZSD_SOA_SRV");
      console.log("Document System en externalService:", documentSystem )
      adjustZsdServiceForSystem(externalService, payload, documentSystem);
      applyHardcodedTestUser(payload, documentSystem);

      const payloadFromDb = Boolean(attachmentId && instanceId);
      const creationType = payloadFromDb ? "Automatically" : "Manual";
      const orderCreatedBy = toStringSafe(req.user?.id) || "system";

      if (individualCreation) {
        const items = ensureArray(payload?.Nav_Item);

        let pr1IndividualOverrides = null;
        if (documentSystem?.toUpperCase() === "PR1") {
          const docId = documentIdForLogs || requestData?.ID;
          if (docId) {
            const db = await cds.connect.to("db");
            const { DocumentLineItems, DocumentHeaderStats, DocumentHeaders } = cds.entities("soautomation");
            const [lineItemOverrideRecords, headerStatsOverride, headerOverride] = await Promise.all([
              DocumentLineItems
                ? db.run(
                    SELECT.from(DocumentLineItems)
                      .columns("ID", "itemNumber", "currencyCode", "documentNumber")
                      .where({ documentID_ID: docId })
                  )
                : [],
              DocumentHeaderStats
                ? db.run(
                    SELECT.one.from(DocumentHeaderStats)
                      .columns("SAPCurrencyCode")
                      .where({ documentID_ID: docId })
                  )
                : null,
              DocumentHeaders
                ? db.run(
                    SELECT.one.from(DocumentHeaders)
                      .columns("currencyCode")
                      .where({ documentID_ID: docId })
                  )
                : null,
            ]);
            const lineItemOverrideMap = new Map();
            ensureArray(lineItemOverrideRecords).forEach((record) => {
              const idKey = toStringSafe(record.ID);
              const itemNumberKey = toStringSafe(record.itemNumber);
              if (idKey) lineItemOverrideMap.set(idKey, record);
              if (itemNumberKey) lineItemOverrideMap.set(itemNumberKey, record);
            });
            pr1IndividualOverrides = {
              lineItemMap: lineItemOverrideMap,
              headerStatsCurrencyCode: toStringSafe(headerStatsOverride?.SAPCurrencyCode),
              headerCurrencyCode: toStringSafe(headerOverride?.currencyCode),
            };
          }
        }

        const requestItems = ensureArray(requestData?.Nav_Item);

        const batchSize = parseInt(process.env.CREATE_BATCH_SIZE, 10) || 5;
        const itemResponses = [];

        for (let batchStart = 0; batchStart < items.length; batchStart += batchSize) {
          const batchItems = items.slice(batchStart, batchStart + batchSize);
          const batchResponses = await Promise.all(
            batchItems.map(async (item, batchIndex) => {
              const index = batchStart + batchIndex;
              const requestItem = requestItems[index] || {};

              // PR1 only — Header ReqDate per individual SO (values from request payload):
              // 1. Nav_Item[n].deliveryDate = Requested Dlv. Date at item level
              // 2. payload.ReqDate          = Header Delivery Date (fallback, sent at both header and item)
              let individualHeaderReqDate = payload.ReqDate;
              if (documentSystem?.toUpperCase() === "PR1") {
                const itemReqDeliveryDate = normalizeDate(pickValue(requestItem, ["deliveryDate", "DeliveryDate"]));
                individualHeaderReqDate = itemReqDeliveryDate || payload.ReqDate;
              }

              let individualPayload = {
                ...payload,
                ReqDate: individualHeaderReqDate,
                Nav_Item: [item],
              };

              if (documentSystem?.toUpperCase() === "PR1" && pr1IndividualOverrides) {
                const lineItemKey = toStringSafe(requestItem?.itemNumber ?? requestItem?.ID);
                const dbLineItem = pr1IndividualOverrides.lineItemMap.get(lineItemKey) || {};

                const itemCurrencyCode =
                  toStringSafe(pickValue(requestItem, ["CurrencyCode", "currencyCode"])) ||
                  toStringSafe(dbLineItem.currencyCode) ||
                  pr1IndividualOverrides.headerStatsCurrencyCode ||
                  pr1IndividualOverrides.headerCurrencyCode ||
                  toStringSafe(payload.CurrencyCode);

                const itemDocumentNumber =
                  toStringSafe(pickValue(requestItem, ["DocumentNumber", "documentNumber"])) ||
                  toStringSafe(dbLineItem.documentNumber) ||
                  toStringSafe(payload.DocumentNumber);

                individualPayload = {
                  ...individualPayload,
                  CurrencyCode: itemCurrencyCode,
                  DocumentNumber: itemDocumentNumber,
                };
              }

              const response = await externalService.tx(req).post("/CreateSOs", individualPayload);
              return {
                ...response,
                ItemNumber: toStringSafe(item?.ItemNumber),
                lineItemId: lineItemsForUpdate[index]?.ID,
              };
            })
          );
          itemResponses.push(...batchResponses);
        }

        const resultPersInd = await persistanceODataCreateResult({
          req,
          result: itemResponses[0] || {},
          resultList: itemResponses,
          individualCreation: true,
          requestData,
          documentIdForLogs,
          lineItemsForUpdate,
          documentSystem,
          payloadFromDb,
          creationType,
          orderCreatedBy,
        });

        if (documentSystem?.toUpperCase() === "PR1") {
          for (const response of itemResponses) {
            if (extractResultStatus(response) === "SUCCESS") {
              const taskId = pickValue(response, ["TaskID", "TaskId", "taskID", "taskId"]);
              await deleteTaskId(taskId, externalService, req);
            }
          }
        }

        return resultPersInd;
      }

      const result = await externalService.tx(req).post("/CreateSOs", payload);
      const resultPers =  await persistanceODataCreateResult({
        req,
        result,
        resultList: [],
        individualCreation: false,
        requestData,
        documentIdForLogs,
        lineItemsForUpdate,
        documentSystem,
        payloadFromDb,
        creationType,
        orderCreatedBy,
      });

      if (documentSystem?.toUpperCase() === "PR1") {
        if (extractResultStatus(result) === "SUCCESS") {
          const taskId = pickValue(result, ["TaskID", "TaskId", "taskID", "taskId"]);
          await deleteTaskId(taskId, externalService, req);
        }
      }

      return resultPers;

    } catch (error) {
      if (isTimeoutError(error)) {
        const documentIdForUpdates = toStringSafe(requestData?.ID) || documentIdForLogs;
        if (documentIdForUpdates) {
          const db = await cds.connect.to("db");
          const { Documents } = cds.entities("soautomation");
          if (Documents) {
            await db.run(
              UPDATE(Documents)
                .set({ status: "BLOCKED" })
                .where({ ID: documentIdForUpdates })
            );
          }
        }
      }

      req.error(400, "Error to Create SO | " + error.message);
    }
  });

  srv.on("deleteDocumentLineItems", async (req) => {
    try {
      const payload = req.data?.data;
      if (!payload || typeof payload !== "object") {
        req.error(400, "Missing request payload");
        return;
      }


      const documentId = pickValue(payload, ["ID", "Id", "id"]);
      if (!documentId) {
        req.error(400, "Document ID is mandatory");
        return;
      }

      const entities = cds.entities("soautomation");
      if (!entities) {
        req.error(400, "CAP Service metadata not available");
        return;
      }

      const { Documents, DocumentLineItems, DocumentFieldHistories } = entities;
      const userEmail = req.user?.attr?.email ?? req.user?.id ?? null;
      const tx = await cds.connect.to("db") || cds.transaction(req)

      const existingDocument = await tx.run(
        SELECT.one
          .from(Documents)
          .where({ ID: documentId })
      );

      if (!existingDocument) {
        req.error(404, "Document not found for provided ID");
        return;
      }

      const lineItemsInput = ensureArray(payload.DocumentLineItems);
      const lineItemIds = lineItemsInput
        .map((item) => pickValue(item, ["ID", "Id", "id"]))
        .filter((id) => id !== undefined && id !== null)
        .map(String);

      if (lineItemIds.length === 0) {
        req.error(400, "At least one DocumentLineItems entry with ID is required");
        return;
      }

      const uniqueItemIds = Array.from(new Set(lineItemIds));

      const itemsToDelete = await tx.run(
        SELECT.from(DocumentLineItems)
          .columns("ID")
          .where({ documentID_ID: documentId, ID: { in: uniqueItemIds } })
      );

      if (!itemsToDelete || itemsToDelete.length === 0) {
        return {
          documentId,
          message: "No matching line items found for deletion",
        };
      }

      const idsForDeletion = itemsToDelete.map((item) => item.ID);

      await tx.run(
        UPDATE(DocumentLineItems)
          .set({ deleted: true })
          .where({ documentID_ID: documentId, ID: { in: idsForDeletion } })
      );

      if (DocumentFieldHistories) {
        const deletionHistoryEntries = idsForDeletion.map((id) => ({
          ID: cds.utils.uuid(),
          documentID_ID: documentId,
          sourceEntity: "DocumentLineItems",
          sourceRecordId: String(id),
          fieldName: "Deleted",
          originalValue: null,
          currentValue: "true",
          userEmail,
        }));

        await tx.run(INSERT.into(DocumentFieldHistories).entries(deletionHistoryEntries));
      }
      await markDocumentCompletedIfProcessed(tx, documentId, resolveUserEmail(req));

      return {
        documentId,
        message: `Marked ${idsForDeletion.length} line item(s) as deleted`,
      };

    } catch (error) {
      req.error(400, "Error to delete Document Line Item | " + error.message);
    }
  });


  srv.on("holdDocuments", async (req) => {
    try {
      const entities = cds.entities("soautomation");
      if (!entities) {
        req.error(400, "CAP Service metadata not available");
        return;
      }

      const { Documents, DocumentLineItems } = entities;
      const tx = cds.transaction(req);

      const documentId = req.data?.data?.documentId ?? req.data?.documentId;
      const rawLogId = req.data?.data?.logId ?? req.data?.logId;
      const comment = toStringSafe(req.data?.data?.comment ?? req.data?.comment ?? "");
      const remarkUpdatedBy = toStringSafe(req.user?.id).trim()
        || toStringSafe(req.user?.attr?.email).trim()
        || null;
      const remarkUpdatedOn = new Date();
      const parsedLogId = rawLogId === null || rawLogId === undefined || rawLogId === ""
        ? null
        : Number(rawLogId);

      if (!documentId && !Number.isInteger(parsedLogId)) {
        req.error(400, "documentId or logId is required");
        return;
      }

      const where = {
        ...(documentId ? { ID: documentId } : {}),
        ...(Number.isInteger(parsedLogId) ? { LogId: parsedLogId } : {}),
      };

      const existingDocument = await tx.run(
        SELECT.one.from(Documents).columns("ID", "status").where(where)
      );

      if (!existingDocument) {
        req.error(400, "Document not found");
        return;
      }

      let nextStatus = "ON HOLD";

      if (toStringSafe(existingDocument.status).trim().toUpperCase() === "ON HOLD") {
        const lineItems = await tx.run(
          SELECT.from(DocumentLineItems)
            .columns("deleted", "SalesOrder")
            .where({ documentID_ID: existingDocument.ID })
        );

        const items = Array.isArray(lineItems) ? lineItems : [];
        const processedCount = items.filter((item) => {
          const salesOrder = toStringSafe(item?.SalesOrder).trim();
          return item?.deleted === true || salesOrder !== "";
        }).length;

        if (processedCount === items.length) {
          nextStatus = "COMPLETED";
        } else if (processedCount > 0) {
          nextStatus = "PENDING";
        } else {
          nextStatus = "NEW";
        }
      }

      const updatedCount = await tx.run(
        UPDATE(Documents)
          .set({
            status: nextStatus,
            holdReason: comment,
            remark: comment,
            remarkUpdatedBy,
            remarkUpdatedOn,
          })
          .where({ ID: existingDocument.ID })
      );

      if (nextStatus === "COMPLETED") {
        await stampDocumentCompletion(tx, existingDocument.ID, resolveUserEmail(req));
      }

      return updatedCount || 0;
    } catch (error) {
      req.error(400, "Error updating hold status | " + error.message);
    }
  });

  srv.on("CancelDocuments", async (req) => {
    try {
      const documents = ensureArray(req.data?.documents);

      if (documents.length === 0) {
        req.error(400, "At least one document is required for cancellation");
        return;
      }

      const entities = cds.entities("soautomation");
      if (!entities) {
        req.error(400, "CAP Service metadata not available");
        return;
      }

      const { Documents } = entities;
      const tx = cds.transaction(req);

      let affectedRows = 0;

      for (const item of documents) {
        if (!item || typeof item !== "object") {
          req.error(400, "Each entry in documents must be an object");
          return;
        }

        const documentId = item.documentId;
        const cancelReason = (item.cancelReason || "").trim();

        if (!documentId) {
          req.error(400, "documentId is mandatory for cancellation");
          return;
        }

        if (!cancelReason) {
          req.error(400, `cancelReason is required for document ${documentId}`);
          return;
        }

        const existingDocument = await tx.run(
          SELECT.one.from(Documents).where({ ID: documentId })
        );

        if (!existingDocument) {
          req.error(400, `Document ${documentId} not found`);
          return;
        }

        const updatedCount = await tx.run(
          UPDATE(Documents)
            .set({ status: "CANCELLED", cancelReason })
            .where({ ID: documentId })
        );

        affectedRows += updatedCount || 0;
      }

      return affectedRows;
    } catch (error) {
      req.error(400, "Error cancelling documents | " + error.message);
    }
  });

  srv.on("deleteDocuments", async (req) => {
    try {
      const entities = cds.entities("soautomation");
      if (!entities) {
        req.error(400, "CAP Service metadata not available");
        return;
      }

      const { Documents } = entities;
      const tx = cds.transaction(req);

      const logIds = ensureArray(req.data?.LogsId ?? req.data?.logsId).filter(
        (value) => value !== null && value !== undefined && value !== ""
      );
      const inboxEmail = (req.data?.InboxEmail ?? req.data?.inboxEmail ?? "").trim();

      if (logIds.length === 0 && !inboxEmail) {
        req.error(400, "LogsId or InboxEmail is required to delete documents");
        return;
      }

      if (logIds.length > 0) {
        const updatedCount = await tx.run(
          UPDATE(Documents)
            .set({ deleted: true })
            .where({ LogId: { in: logIds } })
        );
        return updatedCount || 0;
      }

      if (!inboxEmail) {
        return 0;
      }

      const updatedCount = await tx.run(
        UPDATE(Documents)
          .set({ deleted: true })
          .where({ emailFrom: inboxEmail, training: "X" })
      );

      return updatedCount || 0;
    } catch (error) {
      req.error(400, "Error deleting documents | " + error.message);
    }
  });

  srv.on("unlockDocuments", async (req) => {
    try {
      const entities = cds.entities("soautomation");
      if (!entities) {
        req.error(400, "CAP Service metadata not available");
        return;
      }

      const { Documents, DocumentLineItems } = entities;
      const tx = cds.transaction(req);

      const logIds = ensureArray(req.data?.LogsId ?? req.data?.logsId).filter(
        (value) => value !== null && value !== undefined && value !== ""
      );
      const inboxEmail = (req.data?.InboxEmail ?? req.data?.inboxEmail ?? "").trim();
      const status = (req.data?.Status ?? req.data?.status ?? "NEW").trim();
      const lineItems = ensureArray(req.data?.LineItems ?? req.data?.lineItems)
        .filter((value) => value !== null && value !== undefined && value !== "")
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value));
      const salesOrder = (req.data?.SalesOrder ?? req.data?.salesOrder ?? "").trim();
      const userId = toStringSafe(req.data?.UserId ?? req.data?.userId).trim();

      if (!status) {
        req.error(400, "Status is required to unlock documents");
        return;
      }

      if (logIds.length === 0 && !inboxEmail) {
        req.error(400, "LogsId or InboxEmail is required to unlock documents");
        return;
      }

      if (logIds.length > 0) {
        const parsedLogIds = logIds
          .map((value) => Number(value))
          .filter((value) => Number.isInteger(value));

        if (parsedLogIds.length === 0) {
          req.error(400, "LogsId must contain at least one integer value");
          return;
        }

        const updatedCount = await tx.run(
          UPDATE(Documents)
            .set({ status })
            .where({ LogId: { in: parsedLogIds } })
        );

        if (status === "COMPLETED") {
          const completedDocumentIds = (
            await tx.run(
              SELECT.from(Documents)
                .columns("ID")
                .where({ LogId: { in: parsedLogIds } })
            )
          )
            .map((document) => document?.ID)
            .filter(Boolean);

          for (const id of completedDocumentIds) {
            await stampDocumentCompletion(tx, id, resolveUserEmail(req));
          }
        }

        if (lineItems.length > 0 && (salesOrder || userId) && DocumentLineItems) {
          const documentsByLogId = await tx.run(
            SELECT.from(Documents)
              .columns("ID")
              .where({ LogId: { in: parsedLogIds } })
          );

          const documentIds = documentsByLogId
            .map((document) => document?.ID)
            .filter((id) => !!id);

          if (documentIds.length > 0) {
            const lineItemUpdateData = {
              ...(salesOrder ? { SalesOrder: salesOrder } : {}),
              ...(userId ? { orderCreatedBy: userId } : {}),
            };

            await tx.run(
              UPDATE(DocumentLineItems)
                .set(lineItemUpdateData)
                .where({
                  documentID_ID: { in: documentIds },
                  itemNumber: { in: lineItems },
                })
            );

            if (salesOrder) {
              for (const id of documentIds) {
                await stampLineItemCompletion(tx, id, resolveUserEmail(req));
              }
            }
          }
        }

        return updatedCount || 0;
      }

      if (!inboxEmail) {
        return 0;
      }

      const updatedCount = await tx.run(
        UPDATE(Documents)
          .set({ status })
          .where({ emailFrom: inboxEmail, training: "X" })
      );

      if (status === "COMPLETED") {
        const completedDocumentIds = (
          await tx.run(
            SELECT.from(Documents)
              .columns("ID")
              .where({ emailFrom: inboxEmail, training: "X" })
          )
        )
          .map((document) => document?.ID)
          .filter(Boolean);

        for (const id of completedDocumentIds) {
          await stampDocumentCompletion(tx, id, resolveUserEmail(req));
        }
      }

      return updatedCount || 0;
    } catch (error) {
      req.error(400, "Error unlocking documents | " + error.message);
    }
  });

  srv.on("splitDocument", async (req) => {
    try {
      const payload = req.data?.data;
      if (!payload || typeof payload !== "object") {
        req.error(400, "Missing request payload");
        return;
      }

      const documentId = pickValue(payload, ["ID", "Id", "id"]);
      if (!documentId) {
        req.error(400, "Document ID is mandatory");
        return;
      }

      const entities = cds.entities("soautomation");
      if (!entities) {
        req.error(400, "CAP Service metadata not available");
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
        DocumentCCRecipients,
        DocumentAttachments,
      } = entities;

      const tx = cds.transaction(req) || (await cds.connect.to("db"));
      const userEmail = req.user?.attr?.email ?? req.user?.id ?? null;

      const existingDocument = await tx.run(
        SELECT.one.from(Documents).where({ ID: documentId })
      );

      if (!existingDocument) {
        req.error(404, "Document not found for provided ID");
        return;
      }

      const lineItemsInput = ensureArray(payload.DocumentLineItems);
      const requestedLineItemIds = lineItemsInput
        .map((item) => pickValue(item, ["ID", "Id", "id"]))
        .filter((id) => id !== undefined && id !== null)
        .map(String);
      const uniqueRequestedIds = Array.from(new Set(requestedLineItemIds));

      const [
        headers,
        headerStats,
        soldToOptions,
        shipToOptions,
        materialOptions,
        salesOrgs,
        errorLogs,
        ccRecipients,
        attachments,
        allLineItems,
      ] =
        await Promise.all([
          tx.run(SELECT.from(DocumentHeaders).where({ documentID_ID: documentId })),
          tx.run(SELECT.from(DocumentHeaderStats).where({ documentID_ID: documentId })),
          tx.run(SELECT.from(DocumentSoldToOptions).where({ documentID_ID: documentId })),
          tx.run(SELECT.from(DocumentShipToOptions).where({ documentID_ID: documentId })),
          tx.run(SELECT.from(DocumentMaterialOptions).where({ documentID_ID: documentId })),
          tx.run(SELECT.from(DocumentSalesOrgs).where({ documentID_ID: documentId })),
          tx.run(SELECT.from(DocumentErrorLogs).where({ documentID_ID: documentId })),
          tx.run(SELECT.from(DocumentCCRecipients).where({ documentID_ID: documentId })),
          tx.run(SELECT.from(DocumentAttachments).where({ documentID_ID: documentId })),
          tx.run(SELECT.from(DocumentLineItems).where({ documentID_ID: documentId })),
        ]);

      let itemsToCopy = allLineItems || [];
      if (uniqueRequestedIds.length > 0) {
        const requestedSet = new Set(uniqueRequestedIds.map(String));
        itemsToCopy = itemsToCopy.filter((item) => requestedSet.has(String(item.ID)));

        if (itemsToCopy.length === 0) {
          return {
            documentId,
            message: "No matching line items found for duplication",
          };
        }
      }

      const omitManagedFields = (entry) => {
        const { createdAt, createdBy, modifiedAt, modifiedBy, ...rest } = entry || {};
        return rest;
      };

      const newDocumentId = cds.utils.uuid();

      const newDocument = {
        ...omitManagedFields(existingDocument),
        ID: newDocumentId,
        status: "NEW",
        splitParentLogId: existingDocument.LogId ?? null,
        splitIsParent: false,
      };

      const newHeaders = ensureArray(headers).map((header) => ({
        ...omitManagedFields(header),
        ID: cds.utils.uuid(),
        documentID_ID: newDocumentId,
      }));

      const newHeaderStats = ensureArray(headerStats).map((stat) => ({
        ...omitManagedFields(stat),
        ID: cds.utils.uuid(),
        documentID_ID: newDocumentId,
      }));

      const newSoldToOptions = ensureArray(soldToOptions).map((option) => ({
        ...omitManagedFields(option),
        ID: cds.utils.uuid(),
        documentID_ID: newDocumentId,
      }));

      const newShipToOptions = ensureArray(shipToOptions).map((option) => ({
        ...omitManagedFields(option),
        ID: cds.utils.uuid(),
        documentID_ID: newDocumentId,
      }));

      const newMaterialOptions = ensureArray(materialOptions).map((option) => ({
        ...omitManagedFields(option),
        ID: cds.utils.uuid(),
        documentID_ID: newDocumentId,
      }));

      const newErrorLogs = ensureArray(errorLogs).map((log) => ({
        ...omitManagedFields(log),
        ID: cds.utils.uuid(),
        documentID_ID: newDocumentId,
      }));

      const newSalesOrgs = ensureArray(salesOrgs).map((salesOrg) => ({
        ...omitManagedFields(salesOrg),
        ID: cds.utils.uuid(),
        documentID_ID: newDocumentId,
      }));

      const newCCRecipients = ensureArray(ccRecipients).map((recipient) => ({
        ...omitManagedFields(recipient),
        ID: cds.utils.uuid(),
        documentID_ID: newDocumentId,
      }));

      const newAttachments = ensureArray(attachments).map((attachment) => ({
        ...omitManagedFields(attachment),
        ID: cds.utils.uuid(),
        documentID_ID: newDocumentId,
      }));

      const newLineItems = ensureArray(itemsToCopy).map((item) => ({
        ...omitManagedFields(item),
        ID: cds.utils.uuid(),
        documentID_ID: newDocumentId,
      }));

      const { logId: newLogId } = await insertDocumentWithUniqueLogId(tx, Documents, newDocument);

      const insertPromises = [];
      if (newHeaders.length > 0) {
        insertPromises.push(tx.run(INSERT.into(DocumentHeaders).entries(newHeaders)));
      }
      if (newHeaderStats.length > 0) {
        insertPromises.push(tx.run(INSERT.into(DocumentHeaderStats).entries(newHeaderStats)));
      }
      if (newSoldToOptions.length > 0) {
        insertPromises.push(tx.run(INSERT.into(DocumentSoldToOptions).entries(newSoldToOptions)));
      }
      if (newShipToOptions.length > 0) {
        insertPromises.push(tx.run(INSERT.into(DocumentShipToOptions).entries(newShipToOptions)));
      }
      if (newMaterialOptions.length > 0) {
        insertPromises.push(
          tx.run(INSERT.into(DocumentMaterialOptions).entries(newMaterialOptions))
        );
      }
      if (newErrorLogs.length > 0) {
        insertPromises.push(tx.run(INSERT.into(DocumentErrorLogs).entries(newErrorLogs)));
      }
      if (newSalesOrgs.length > 0) {
        insertPromises.push(tx.run(INSERT.into(DocumentSalesOrgs).entries(newSalesOrgs)));
      }
      if (newCCRecipients.length > 0) {
        insertPromises.push(
          tx.run(INSERT.into(DocumentCCRecipients).entries(newCCRecipients))
        );
      }
      if (newAttachments.length > 0) {
        insertPromises.push(
          tx.run(INSERT.into(DocumentAttachments).entries(newAttachments))
        );
      }
      if (newLineItems.length > 0) {
        insertPromises.push(tx.run(INSERT.into(DocumentLineItems).entries(newLineItems)));
      }

      await Promise.all(insertPromises);

      const idsToMarkDeleted = Array.from(
        new Set(itemsToCopy.map((item) => item.ID).filter((id) => id !== undefined && id !== null))
      );

      if (idsToMarkDeleted.length > 0) {
        await tx.run(
          UPDATE(DocumentLineItems)
            .set({ deleted: true })
            .where({ documentID_ID: documentId, ID: { in: idsToMarkDeleted } })
        );

        if (DocumentFieldHistories) {
          const deletionHistoryEntries = idsToMarkDeleted.map((id) => ({
            ID: cds.utils.uuid(),
            documentID_ID: documentId,
            sourceEntity: "DocumentLineItems",
            sourceRecordId: String(id),
            fieldName: "Deleted",
            originalValue: null,
            currentValue: "true",
            userEmail,
          }));

          await tx.run(INSERT.into(DocumentFieldHistories).entries(deletionHistoryEntries));
        }
      }

      if (DocumentFieldHistories) {
        const originalLogId = existingDocument.LogId != null ? String(existingDocument.LogId) : null;
        const splitLogId = newLogId != null ? String(newLogId) : null;
        const splitHistoryEntries = [
          {
            ID: cds.utils.uuid(),
            documentID_ID: documentId,
            sourceEntity: "SPLIT",
            sourceRecordId: documentId,
            fieldName: "LogId",
            originalValue: originalLogId,
            currentValue: splitLogId,
            userEmail,
          },
          {
            ID: cds.utils.uuid(),
            documentID_ID: newDocumentId,
            sourceEntity: "SPLIT",
            sourceRecordId: newDocumentId,
            fieldName: "LogId",
            originalValue: originalLogId,
            currentValue: splitLogId,
            userEmail,
          },
        ];
        await tx.run(INSERT.into(DocumentFieldHistories).entries(splitHistoryEntries));
      }

      await tx.run(
        UPDATE(Documents)
          .set({ splitIsParent: true })
          .where({ ID: documentId })
      );

      await markDocumentCompletedIfProcessed(tx, documentId, resolveUserEmail(req));

      return {
        documentId: newDocumentId,
        message: "Document duplicated successfully",
      };

    } catch (error) {
      req.error(400, "Error to Split Document | " + error.message);
    }
  });

  srv.on("getUserInfo", async (req) => {
    try {
      const user = req.user;

      if (!user) {
        req.error(401, "User not authenticated");
      }

      const userAttr = user.attr || {};
      const email = userAttr.email || null;
      const givenName = userAttr.givenName || null;
      const familyName = userAttr.familyName || null;
      const userId = user.id || null;

      // Roles: obtener nombres y filtrar openid / uaa.user
      const roles = user.roles
        ? Object.keys(user.roles).filter(
          role => role !== "openid" && role !== "uaa.user"
        )
        : [];

      return {
        email,
        userId,
        givenName,
        familyName,
        roles
      };


    } catch (e) {
      req.error(400, "Error to Get User Info | " + error.message);
    }
  });

  srv.on("getDoxBaseUrl", async (req) => {
    try {
      const user = req.user;

      if (!user) {
        req.error(401, "User not authenticated");
      }

      const response = resolveDoxSubdomainUrl()
      // const userAttr = user.attr || {};
      return response

    } catch (e) {
      req.error(400, "Error to Get User Info | " + error.message);
    }
  });

  srv.on("postPackProposal", async (req) => {
    try {
      const payload = req.data;
      if (!payload) {
        req.error(400, "Missing request payload");
        return;
      }
      // Normalizar SalesOrg si viene con descripción
      if (toStringSafe(payload.SalesOrg)) {
        payload.SalesOrg = payload.SalesOrg?.split(" - ")?.[0]?.trim() || "";
      }
      const externalService = await cds.connect.to("ZSD_SOA_SRV");
      adjustZsdServiceForSystem(externalService, payload, "PR1");
      const result = await externalService.tx(req).post("/PackProposals", payload);
      return result

    } catch (e) {
      req.error(400, "Error in PackProposal | " + error.message);
    }
  })
  srv.on("postTrainingRequest", async (req) => {
    try {
      const payload = req.data;
      if (!payload) {
        req.error(400, "Missing request payload");
        return;
      }
      const { Documents } = cds.entities("soautomation");
      const docRecord = await cds.tx(req).run(SELECT.one.from(Documents).where({ LogId: payload.LogId }));
      const system = String(docRecord?.system || "").toUpperCase();
      const externalService = await cds.connect.to("ZSD_SOA_SRV");
      adjustZsdServiceForSystem(externalService, payload, system);
      const result = await externalService.tx(req).post("/TrainingNotifications", payload);
      return result

    } catch (e) {
      req.error(400, "Error in Training Request | " + e.message);
    }
  })
  srv.on("postPartnerDetails", async (req) => {
    try {
      const payload = req.data;
      if (!payload) {
        req.error(400, "Missing request payload");
        return;
      }
      // Normalizar SalesOrg si viene con descripción
      if (toStringSafe(payload.SalesOrg)) {
        payload.SalesOrg = payload.SalesOrg?.split(" - ")?.[0]?.trim() || "";
      }
      const externalService = await cds.connect.to("ZSD_SOA_SRV");
      adjustZsdServiceForSystem(externalService, payload, "PR1");
      const result = await externalService.tx(req).post("/Partners", payload);
      return result

    } catch (e) {
      req.error(400, "Error in Partner Details | " + error.message);
    }
  })
  srv.on("oDataDeterminePR1", async (req) => {
    try {
      const payloadEnvelope = req.data?.data ?? req.data ?? {};
      const payload = payloadEnvelope?.data?.data ?? payloadEnvelope;

      if (!payload || typeof payload !== "object") {
        req.error(400, "Missing request payload");
        return;
      }

      const documentId = pickValue(payload, [
        "documentId",
        "documentID",
        "DocumentId",
        "DocumentID",
        "ID",
      ]);

      if (!documentId) {
        req.error(400, "Missing documentId in request payload");
        return;
      }

      // Encontramos el documento en cuestión + sus tablas de navegación
      const entities = cds.entities("soautomation");
      if (!entities) {
        req.error(500, "CAP Service metadata not available");
        return;
      }

      const { Documents, DocumentHeaders, DocumentLineItems, DocumentSalesOrgs } = entities;

      const tx = cds.transaction(req) || (await cds.connect.to("db"));

      const existingDocument = await tx.run(
        SELECT.one
          .from(Documents)
          .columns(
            "ID",
            "attachmentId",
            "instanceId",
            "emailSender",
            "receivedDatetime",
            "subject",
            "emailFrom",
            "LogId"
          )
          .where({ ID: documentId })
      );

      if (!existingDocument) {
        req.error(404, "Document not found for provided documentId");
        return;
      }

      const shouldReExtract = parseBooleanFlag(
        pickValue(payload, ["reExtractData", "ReExtractData"]),
        true
      );

      if (shouldReExtract) {
        if (!existingDocument.attachmentId || !existingDocument.instanceId) {
          req.error(
            400,
            "Document is missing attachmentId or instanceId required to refresh DOX extraction"
          );
          return;
        }

        // 1) Refrescar extracción de Document AI
        // 2) upsertDocument se ejecuta internamente al final de getDoxExtractedFields
        await srv.send("getDoxExtractedFields", {
          attachmentId: existingDocument.attachmentId,
          instanceId: existingDocument.instanceId,
          emailSender: existingDocument.emailSender,
          receivedDatetime: existingDocument.receivedDatetime,
          subject: existingDocument.subject,
          emailFrom: existingDocument.emailFrom,
          reExtractionFromODataDeterminePR1: true,
          skipUpsert: false,
        });
      }

      const headerRecord =
        (await tx.run(
          SELECT.one.from(DocumentHeaders).where({ documentID_ID: documentId })
        )) || {};

      const dbLineItems =
        (await tx.run(
          SELECT.from(DocumentLineItems)
            .where({ documentID_ID: documentId })
            .orderBy("itemNumber")
        )) || [];

      const formatHeaderValue = (key, value) => {
        if (value === undefined || value === null || (typeof value === "string" && !value.trim())) {
          return "";
        }

        if (key === "NetAmount" || key === "GrossAmount") {
          return formatAmountValue(value);
        }

        if (key === "Quantity") {
          const sanitized = sanitizeQuantityValue(value);
          return sanitized !== null && sanitized !== undefined
            ? String(sanitized)
            : toStringSafe(value);
        }

        return toStringSafe(value);
      };

      const headerFieldMap = {
        PurchaseOrder: "documentNumber",
        TaxId: "taxId",
        NetAmount: "netAmount",
        GrossAmount: "grossAmount",
        CurrencyCode: "currencyCode",
        DocumentDate: "documentDate",
        DeliveryDate: "deliveryDate",
        PaymentTerms: "paymentTerms",
        SenderBankAccount: "senderBankAccount",
        SenderAddress: "senderAddress",
        SenderName: "senderName",
        ShipToAddress: "shipToAddress",
        TaxIdNumber: "taxIdNumber",
        ReceiverId: "receiverId",
        ShippingTerms: "shippingTerms",
        Quantity: "quantity",
        SenderId: "senderId",
        SenderStreet: "senderStreet",
        SenderCity: "senderCity",
        SenderHouseNumber: "senderHouseNumber",
        SenderPostalCode: "senderPostalCode",
        SenderCountryCode: "senderCountryCode",
        SenderPhone: "senderPhone",
        SenderFax: "senderFax",
        SenderEmail: "senderEmail",
        SenderState: "senderState",
        SenderDistrict: "senderDistrict",
        SenderExtAddressPart: "senderExtraAddressPart",
        ShipToName: "shipToName",
        ShipToStreet: "shipToStreet",
        ShipToCity: "shipToCity",
        ShipToHouseNumber: "shipToHouseNumber",
        ShipToPostalCode: "shipToPostalCode",
        ShipToCountryCode: "shipToCountryCode",
        ShipToPhone: "shipToPhone",
        ShipToFax: "shipToFax",
        ShipToEmail: "shipToEmail",
        ShipToState: "shipToState",
        ShipToDistrict: "shipToDistrict",
        ShipToExtraAddressPart: "shipToExtraAddressPart",
        ShipToId: "shipToId",
        Internal: "internal",
      };

      const headerPayload = Object.entries(headerFieldMap).reduce((acc, [payloadKey, dbKey]) => {
        acc[payloadKey] = formatHeaderValue(payloadKey, headerRecord?.[dbKey]);
        return acc;
      }, {});

      const formatLineValue = (key, value) => {
        if (value === undefined || value === null || (typeof value === "string" && !value.trim())) {
          return "";
        }

        if (key === "NetAmount" || key === "UnitPrice") {
          return formatAmountValue(value);
        }

        if (key === "Quantity") {
          const sanitized = sanitizeQuantityValue(value);
          return sanitized !== null && sanitized !== undefined
            ? String(sanitized)
            : toStringSafe(value);
        }

        return toStringSafe(value);
      };

      const navLineItems = dbLineItems
        .filter((item) => !item?.deleted)
        .map((dbItem, index) => ({
          DocumentNumber: toStringSafe(dbItem?.documentNumber || headerPayload.PurchaseOrder),
          ItemNumber: formatItemNumber(dbItem?.itemNumber, index),
          Description: formatLineValue("Description", dbItem?.description),
          NetAmount: formatLineValue("NetAmount", dbItem?.netAmount),
          Quantity: formatLineValue("Quantity", dbItem?.quantity),
          UnitPrice: formatLineValue("UnitPrice", dbItem?.unitPrice),
          DocumentDate: formatLineValue("DocumentDate", dbItem?.documentDate || headerPayload.DeliveryDate || headerPayload.DocumentDate),
          CurrencyCode: formatLineValue("CurrencyCode", dbItem?.currencyCode || headerPayload.CurrencyCode),
          SupplierMatNum: formatLineValue("SupplierMatNum", dbItem?.supplierMaterialNumber),
          CustomerMatNum: formatLineValue("CustomerMatNum", dbItem?.customerMaterialNumber),
          UnitOfMeasure: formatLineValue("UnitOfMeasure", dbItem?.unitOfMeasure),
        }));

      let validatePayload = {
        ...headerPayload,
        Nav_LineItem: navLineItems,
        Nav_BillTo: [{}],
        Nav_HeaderStat: [{}],
        Nav_ItemStat: [{}],
        Nav_OrderType: [{}],
        Nav_Payer: [{}],
        Nav_SalesOrg: [{}],
        Nav_ShipTo: [{}],
        Nav_SoldTo: [{}],
        Nav_Return: [{}],
      };

      validatePayload = buildPr1ODataPayload(validatePayload);

      validatePayload.VendorCountryCode = toStringSafe(headerRecord?.vendorCountryCode);

      const salesOrgRecord =
        (await tx.run(
          SELECT.one
            .from(DocumentSalesOrgs)
            .columns("SalesOrg", "Division")
            .where({ documentID_ID: documentId })
            .orderBy("modifiedAt desc")
        )) || {};

      const requestSalesOrg = toStringSafe(pickValue(payload, ["SalesOrg", "salesOrg"]))
        .split(" - ")[0]
        .trim();
      const requestDivision = toStringSafe(pickValue(payload, ["Division", "division"])).trim();

      const dbSalesOrg = toStringSafe(salesOrgRecord?.SalesOrg).trim();
      const dbDivision = toStringSafe(salesOrgRecord?.Division).trim();

      const resolvedSalesOrg = requestSalesOrg || dbSalesOrg;
      const resolvedDivision = requestDivision || dbDivision;

      validatePayload.SalesOrg = resolvedSalesOrg;
      if (resolvedDivision) {
        validatePayload.Division = resolvedDivision;
      }

      if (!shouldReExtract) {
        validatePayload.DetermineKNMT = "X"
        const requestSenderId = toStringSafe(pickValue(payload, ["SenderId", "senderId"])).trim();
        if (requestSenderId) {
          validatePayload.SenderId = requestSenderId;
        }

        const requestShipToId = toStringSafe(pickValue(payload, ["ShipToId", "shipToId"])).trim();
        if (requestShipToId) {
          validatePayload.ShipToId = requestShipToId;
        }
      } else {
        validatePayload.DetermineKNMT = ""
      }

      validatePayload.EmailBox = toStringSafe(existingDocument?.emailSender);
      validatePayload.SendingEmail = toStringSafe(existingDocument?.emailFrom);
      validatePayload.LogId = toStringSafe(existingDocument?.LogId);
      validatePayload.Subject = toStringSafe(existingDocument?.subject);

      // Hacemos el POST
      const externalService = await cds.connect.to("ZSD_SOA_SRV");
      adjustZsdServiceForSystem(externalService, validatePayload, "PR1");
      let endpoint = `/SalesOrders`
      const result = await externalService.tx(req).post(endpoint, validatePayload);

      await persistODataDetermineResult(
        result,
        {
          documentId,
          ID: documentId,
          documentSystem: "PR1",
          system: "PR1",
          logSource: "VALIDATE",
        },
        req
      );

      if (extractResultStatus(result) === "SUCCESS") {
        const taskId = pickValue(result, ["TaskID", "TaskId", "taskID", "taskId"]);
        await deleteTaskId(taskId, externalService, req);
      }

      return {
        result
      };
    } catch (e) {
      req.error(400, "Error in oDataDeterminePR1 | " + e.message);
    }
  })

  srv.on("resetLogId", async (req) => {
    try {
      const entities = cds.entities("soautomation");
      if (!entities) {
        req.error(400, "CAP Service metadata not available");
        return;
      }

      const { Documents, DocumentLineItems } = entities;
      const tx = cds.transaction(req);

      const data = req.data?.data ?? req.data ?? {};
      const documentId = toStringSafe(data.documentId).trim();
      const attachmentId = toStringSafe(data.attachmentId).trim();
      const instanceId = toStringSafe(data.instanceId).trim();
      const rawLogId = data.logId;
      const parsedLogId = rawLogId === null || rawLogId === undefined || rawLogId === ""
        ? null
        : Number(rawLogId);

      const where = {
        ...(documentId ? { ID: documentId } : {}),
        ...(attachmentId ? { attachmentId } : {}),
        ...(instanceId ? { instanceId } : {}),
        ...(Number.isInteger(parsedLogId) ? { LogId: parsedLogId } : {}),
      };

      if (Object.keys(where).length === 0) {
        req.error(400, "At least one of documentId, attachmentId, logId or instanceId is required");
        return;
      }

      const existingDocument = await tx.run(
        SELECT.one.from(Documents).columns("ID").where(where)
      );

      if (!existingDocument) {
        req.error(400, "Document not found");
        return;
      }

      const updatedCount = await tx.run(
        UPDATE(Documents)
          .set({ status: "NEW", completedAt: null, completedBy: null })
          .where({ ID: existingDocument.ID })
      );

      await tx.run(
        UPDATE(DocumentLineItems)
          .set({ SalesOrder: "", orderCreatedBy: null, completedAt: null, completedBy: null })
          .where({ documentID_ID: existingDocument.ID })
      );

      return updatedCount || 0;
    } catch (error) {
      req.error(400, "Error resetting document | " + error.message);
    }
  });
  srv.on("blockDocuments", async (req) => {
    try {
      const entities = cds.entities("soautomation");
      if (!entities) {
        req.error(400, "CAP Service metadata not available");
        return;
      }

      const { Documents } = entities;
      const tx = cds.transaction(req);

      const data = req.data?.data ?? req.data ?? {};
      const attachmentId = toStringSafe(data.attachmentId).trim();
      const instanceId = toStringSafe(data.instanceId).trim();
      const rawLogId = data.logId;
      const parsedLogId = rawLogId === null || rawLogId === undefined || rawLogId === ""
        ? null
        : Number(rawLogId);

      const where = {
        ...(attachmentId ? { attachmentId } : {}),
        ...(instanceId ? { instanceId } : {}),
        ...(Number.isInteger(parsedLogId) ? { LogId: parsedLogId } : {}),
      };

      if (Object.keys(where).length === 0) {
        req.error(400, "At least one of logId, attachmentId or instanceId is required");
        return;
      }

      const existingDocument = await tx.run(
        SELECT.one.from(Documents).columns("ID").where(where)
      );

      if (!existingDocument) {
        req.error(400, "Document not found");
        return;
      }

      const updatedCount = await tx.run(
        UPDATE(Documents)
          .set({ status: "BLOCKED" })
          .where({ ID: existingDocument.ID })
      );

      return updatedCount || 0;
    } catch (error) {
      req.error(400, "Error blocking document | " + error.message);
    }
  });

}
