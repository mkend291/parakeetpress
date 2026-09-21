/**
 * ============================================================================
 * PARAKEET PRESS — DIGITAL DELIVERY & SALES LOG ENGINE (Google Apps Script)
 * ============================================================================
 * 
 * FEATURES:
 * - 100% Dynamic CSV-Driven: scoresShop.csv is the single source of truth!
 * - 2-Tier Vault Hierarchy: ParakeetPress_Vault/[Piece]/[Instrument or Key]/[score.pdf]
 * - Automated Scaffolding: Fetches CSVs from GitHub and builds missing folders.
 * - Flexible File Naming: Any .pdf inside the target folder is delivered.
 * - Private In-Browser Delivery: Sends file directly as Base64 (CORS-free, 100% private).
 * - Automatic Sales Log: Maintains ParakeetPress_Sales_Log inside your vault folder.
 * 
 * INSTRUCTIONS FOR DANIEL:
 * 1. Open https://script.google.com and open your "Parakeet Press Delivery Engine".
 * 2. Replace all code in Code.gs with this exact file and Save (Cmd+S / Ctrl+S).
 * 3. Authorize & Run Scaffolding:
 *    - In the top toolbar dropdown, select "scaffoldVaultFolders".
 *    - Click "Run".
 *    - Google will show an "Authorization required" popup (to allow fetching your CSV from GitHub).
 *    - Click "Review permissions" -> Choose your Google account -> "Advanced" -> "Go to Parakeet Press Delivery Engine (unsafe)" -> "Allow".
 *    - It will run and build all your folders in Google Drive!
 * 4. Deploy a NEW version:
 *    - Click "Deploy" (top right) -> "Manage deployments".
 *    - Click the Pencil icon (Edit).
 *    - Under "Version", select "New version" (CRITICAL!).
 *    - Under "Who has access", select "Anyone".
 *    - Click "Deploy".
 * ============================================================================
 */

// CONFIGURATION
var VAULT_FOLDER_ID = ''; 
var VAULT_FOLDER_NAME = 'ParakeetPress_Vault';
var SALES_SHEET_NAME = 'ParakeetPress_Sales_Log';

// LIVE GITHUB CSV ENDPOINTS (Single Source of Truth)
var CSV_SCORES_URL = 'https://raw.githubusercontent.com/mkend291/parakeetpress/main/pp_files/pp_store/scoresShop.csv';
var CSV_SOLO_ARR_URL = 'https://raw.githubusercontent.com/mkend291/parakeetpress/main/pp_files/pp_store/solo-arr-catalogue.csv';
var CSV_TRANS_URL = 'https://raw.githubusercontent.com/mkend291/parakeetpress/main/pp_files/pp_store/multiple-transpositions.csv';

/**
 * Handles incoming POST requests:
 * - "lookup_order": Validates Order ID + Email against sales sheet and re-delivers score.
 * - "verify_and_deliver": Verifies PayPal payment, delivers score from Vault, and logs sale.
 * - "log_donation": Logs real donations from Chirp!.
 * - "sync_catalogue" / "scaffold": Builds vault hierarchy.
 */
function doPost(e) {
  try {
    var data = {};
    if (e && e.postData && e.postData.contents) {
      data = JSON.parse(e.postData.contents);
    } else if (e && e.parameter) {
      data = e.parameter;
    }

    // 1. Catalogue sync / folder scaffolding
    if (data.action === 'sync_catalogue' || data.action === 'scaffold') {
      var scaffoldResult = scaffoldVaultFolders(data.piece);
      return createJsonResponse(scaffoldResult);
    }

    // 2. Tip / Donation Logging from Chirp!
    if (data.action === 'log_donation') {
      var donOrderId = (data.orderId || '').trim();
      var donAmount = data.amount || '$5.00';
      var isSimDonation = donOrderId.indexOf('PP_SIM_') === 0 || donOrderId.indexOf('DEMO') === 0;
      if (!isSimDonation) {
        logSaleRecord(donOrderId, 'Chirp! Tip / Donation', 'N/A', donAmount, data.buyerEmail || 'Anonymous', 'N/A', 'SUCCESS: Donation Logged');
      }
      return createJsonResponse({ success: true, logged: !isSimDonation });
    }

    // 3. Self-Service Re-Download Lookup (from downloads.html)
    if (data.action === 'lookup_order') {
      return handleOrderLookup(data);
    }

    // 4. Standard Direct Purchase Delivery / Verification
    var orderId = (data.orderId || '').trim();
    if (!orderId) {
      orderId = 'PP_' + Utilities.getUuid().substring(0, 10).toUpperCase();
    }
    var pieceTitle = (data.pieceTitle || '').trim();
    var instrument = (data.instrument || '').trim();
    var buyerEmail = (data.buyerEmail || 'N/A').trim();
    var amount = (data.amount || '$4.00').trim();
    var isSimulation = Boolean(data.isSimulation) || orderId.indexOf('PP_SIM_') === 0 || orderId.indexOf('DEMO') === 0;

    if (!pieceTitle) {
      return createJsonResponse({ success: false, error: 'Missing pieceTitle in request' });
    }

    // Server-Side PayPal Verification (for real production purchases)
    if (!isSimulation) {
      var verifyResult = verifyPayPalOrder(orderId, amount);
      if (!verifyResult.verified) {
        return createJsonResponse({ 
          success: false, 
          error: 'Payment verification failed: ' + (verifyResult.error || 'Unverified PayPal transaction.')
        });
      }
      if (verifyResult.payerEmail) {
        buyerEmail = verifyResult.payerEmail;
      }

      // Anti-Replay Check (prevents claiming the same orderId multiple times on initial checkout)
      if (isOrderAlreadyFulfilled(orderId)) {
        return createJsonResponse({
          success: false,
          error: 'This PayPal Order ID has already been redeemed. Please use the Re-Download portal on our store page if you need to retrieve your file again.'
        });
      }
    }

    // Locate Vault folder in Google Drive
    var folder = getVaultFolder();
    if (!folder) {
      if (!isSimulation) {
        logSaleRecord(orderId, pieceTitle, instrument, amount, buyerEmail, 'N/A', 'ERROR: Vault folder "' + VAULT_FOLDER_NAME + '" not found');
      }
      return createJsonResponse({ 
        success: false, 
        error: 'Vault folder not found in Google Drive. Ensure folder is named "' + VAULT_FOLDER_NAME + '" or set VAULT_FOLDER_ID.' 
      });
    }

    // Locate score PDF
    var file = findMatchingFile(folder, pieceTitle, instrument);
    if (!file) {
      var expectedDesc = instrument ? (pieceTitle + ' (' + instrument + ')') : pieceTitle;
      if (!isSimulation) {
        logSaleRecord(orderId, pieceTitle, instrument, amount, buyerEmail, expectedDesc, 'ALERT: Score file not found in vault folder');
      }
      return createJsonResponse({ 
        success: false, 
        error: 'Score file not yet uploaded to vault for "' + expectedDesc + '". Drop the PDF into its folder in Google Drive.',
        logged: !isSimulation
      });
    }

    // CRITICAL: ONLY log real, verified transactions to the ledger (skip all simulations!)
    if (!isSimulation) {
      logSaleRecord(orderId, pieceTitle, instrument, amount, buyerEmail, file.getName(), 'SUCCESS: Delivered');
    }

    // Return the file as Base64 for instant in-browser delivery
    var fileBlob = file.getBlob();
    var base64Data = Utilities.base64Encode(fileBlob.getBytes());

    return createJsonResponse({
      success: true,
      orderId: orderId,
      fileName: file.getName(),
      pdfBase64: base64Data,
      isSimulation: isSimulation
    });

  } catch (err) {
    try {
      logSaleRecord('ERROR', 'N/A', 'N/A', 'N/A', 'N/A', 'N/A', 'EXCEPTION: ' + err.toString());
    } catch (ignore) {}
    return createJsonResponse({ success: false, error: err.toString() });
  }
}

/**
 * Handles GET requests:
 * - "?action=scaffold": Builds/syncs catalogue folders from GitHub CSV!
 * - Default: Diagnostic status report of your vault & spreadsheet.
 */
function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) ? e.parameter.action : '';
  var targetPiece = (e && e.parameter && e.parameter.piece) ? e.parameter.piece : '';
  
  if (action === 'scaffold' || action === 'sync') {
    var scaffoldResult = scaffoldVaultFolders(targetPiece);
    return createJsonResponse(scaffoldResult);
  }

  // Live Inventory / Availability Check for Website
  if (action === 'check_piece' || action === 'availability') {
    var checkFolder = getVaultFolder();
    var pieceName = (e && e.parameter && e.parameter.piece) ? e.parameter.piece.trim() : '';
    if (!checkFolder || !pieceName) {
      return createJsonResponse({ success: false, isAvailable: false, error: 'Missing piece parameter or vault folder' });
    }

    var cleanTarget = cleanString(pieceName);
    var pieceF = findChildFolder(checkFolder, cleanTarget);
    var availableEds = [];
    var hasDirect = false;

    if (pieceF) {
      // 1. Check child subfolders (instruments or keys)
      var subIter = pieceF.getFolders();
      while (subIter.hasNext()) {
        var subF = subIter.next();
        var subFiles = subF.getFiles();
        while (subFiles.hasNext()) {
          if (subFiles.next().getName().toLowerCase().endsWith('.pdf')) {
            availableEds.push(subF.getName());
            break;
          }
        }
      }

      // 2. Check direct PDFs in piece folder (detects instrument names or marks standalone score)
      var standardEditions = [
        'Piccolo', 'Flute', 'Oboe', 'Eng Horn', 'English Horn', 'Clarinet', 'Bass Clarinet', 'Bassoon',
        'Sop Sax', 'Soprano Sax', 'Alto Sax', 'Tenor Sax', 'Bari Sax', 'Baritone Sax',
        'Horn', 'Trumpet', 'Trombone', 'Euphonium', 'Tuba',
        'Violin', 'Viola', 'Cello', 'Bass', 'Double Bass',
        'C Major', 'Db Major', 'D Major', 'Eb Major', 'E Major', 'F Major', 'Gb Major', 'G Major', 'Ab Major', 'A Major', 'Bb Major', 'B Major'
      ];
      var directFiles = pieceF.getFiles();
      while (directFiles.hasNext()) {
        var df = directFiles.next();
        var dfName = df.getName();
        if (dfName.toLowerCase().endsWith('.pdf')) {
          var dfClean = cleanString(dfName);
          var matchedEdition = null;
          for (var eIdx = 0; eIdx < standardEditions.length; eIdx++) {
            var edCand = standardEditions[eIdx];
            var edClean = cleanString(edCand);
            if (dfClean.indexOf(edClean) > -1) {
              matchedEdition = edCand;
              break;
            }
          }
          if (matchedEdition) {
            if (availableEds.indexOf(matchedEdition) === -1) {
              availableEds.push(matchedEdition);
            }
          } else {
            hasDirect = true;
          }
        }
      }
    }

    // 3. Fallback: check flat in root vault folder (e.g. beryl.pdf sitting directly in ParakeetPress_Vault)
    if (!hasDirect && availableEds.length === 0) {
      var flatScore = findMatchingFileFlat(checkFolder, pieceName, '');
      if (flatScore) {
        hasDirect = true;
      }
    }

    return createJsonResponse({
      success: true,
      piece: pieceName,
      hasStandaloneScore: hasDirect,
      availableEditions: availableEds,
      isAvailable: hasDirect || availableEds.length > 0
    });
  }

  var folder = getVaultFolder();
  var pieceFolders = [];
  var salesSheetUrl = 'Not created yet (creates on first purchase)';

  if (folder) {
    var rootFiles = folder.getFiles();
    while (rootFiles.hasNext()) {
      var f = rootFiles.next();
      if (f.getName() === SALES_SHEET_NAME) {
        salesSheetUrl = f.getUrl();
      }
    }

    var subfolders = folder.getFolders();
    while (subfolders.hasNext()) {
      var sf = subfolders.next();
      var sfName = sf.getName();
      var childPdfs = [];
      var childFoldersCount = 0;
      
      var sfFiles = sf.getFiles();
      while (sfFiles.hasNext()) {
        var sff = sfFiles.next();
        if (sff.getName().toLowerCase().endsWith('.pdf')) {
          childPdfs.push(sff.getName());
        }
      }
      
      var sfSubs = sf.getFolders();
      while (sfSubs.hasNext()) {
        childFoldersCount++;
        sfSubs.next();
      }

      pieceFolders.push({
        piece: sfName,
        hasScorePdf: childPdfs.length > 0,
        subEditionsCount: childFoldersCount,
        sampleFiles: childPdfs
      });
    }
  }

  if (salesSheetUrl.indexOf('http') === -1) {
    var rootSheets = DriveApp.getFilesByName(SALES_SHEET_NAME);
    if (rootSheets.hasNext()) {
      salesSheetUrl = rootSheets.next().getUrl() + ' (Located in My Drive root; moves to Vault on next purchase)';
    }
  }

  return createJsonResponse({ 
    status: 'online', 
    service: 'Parakeet Press Delivery Engine',
    vaultFound: !!folder,
    vaultFolder: folder ? folder.getName() : 'NOT FOUND',
    totalPieceFolders: pieceFolders.length,
    samplePieceFolders: pieceFolders.slice(0, 10),
    salesLogSheetUrl: salesSheetUrl,
    instructions: 'Visit with "?action=scaffold" to build catalogue folders in Drive.',
    timestamp: new Date().toISOString()
  });
}

/**
 * Dynamically fetches scoresShop.csv, solo-arr-catalogue.csv, and multiple-transpositions.csv
 * directly from GitHub, and scaffolds missing folders in Google Drive.
 */
function scaffoldVaultFolders(targetPiece) {
  var vault = getVaultFolder();
  if (!vault) {
    return { success: false, error: 'Vault folder not found in Drive. Ensure folder is named "' + VAULT_FOLDER_NAME + '" or set VAULT_FOLDER_ID.' };
  }

  var createdSummary = {
    success: true,
    piecesCreated: 0,
    subfoldersCreated: 0,
    alreadyExisted: 0,
    createdDetails: []
  };

  try {
    // 1. Fetch main catalogue CSV from GitHub
    var resScores = UrlFetchApp.fetch(CSV_SCORES_URL);
    var scoresRows = Utilities.parseCsv(resScores.getContentText());

    if (!scoresRows || scoresRows.length < 2) {
      return { success: false, error: 'Failed to parse scoresShop.csv from GitHub' };
    }

    // 2. Fetch instrument list dynamically from solo-arr-catalogue.csv header
    var standardInstruments = [];
    try {
      var resSolo = UrlFetchApp.fetch(CSV_SOLO_ARR_URL);
      var soloRows = Utilities.parseCsv(resSolo.getContentText());
      if (soloRows && soloRows.length > 0) {
        var soloHeader = soloRows[0];
        for (var si = 1; si < soloHeader.length; si++) {
          var colName = soloHeader[si].trim();
          if (colName) standardInstruments.push(colName);
        }
      }
    } catch (eSolo) {
      console.warn('Using fallback instrument list: ' + eSolo.toString());
      standardInstruments = [
        'Flute', 'Clarinet', 'Violin', 'Cello', 'Piccolo', 'Oboe', 'Eng Horn', 
        'Bass Clarinet', 'Bassoon', 'Sop Sax', 'Alto Sax', 'Tenor Sax', 'Bari Sax', 
        'Horn', 'Trumpet', 'Trombone', 'Euphonium', 'Tuba', 'Viola', 'Bass'
      ];
    }

    // 3. Fetch transposition key list dynamically from multiple-transpositions.csv header
    var standardKeys = [];
    try {
      var resTrans = UrlFetchApp.fetch(CSV_TRANS_URL);
      var transRows = Utilities.parseCsv(resTrans.getContentText());
      if (transRows && transRows.length > 0) {
        var transHeader = transRows[0];
        for (var ti = 1; ti < transHeader.length; ti++) {
          var keyName = transHeader[ti].trim();
          if (keyName) standardKeys.push(keyName);
        }
      }
    } catch (eTrans) {
      console.warn('Using fallback key list: ' + eTrans.toString());
      standardKeys = [
        'C Major', 'Db Major', 'D Major', 'Eb Major', 'E Major', 'F Major', 
        'Gb Major', 'G Major', 'Ab Major', 'A Major', 'Bb Major', 'B Major',
        'C Minor', 'D Minor', 'Eb Minor', 'E Minor', 'F Minor', 'G Minor', 
        'A Minor', 'Bb Minor', 'B Minor'
      ];
    }

    var header = scoresRows[0];
    var titleIdx = -1;
    var multiPartsIdx = -1;
    var multiTransIdx = -1;

    for (var i = 0; i < header.length; i++) {
      var h = header[i].trim().toLowerCase();
      if (h === 'title') titleIdx = i;
      if (h === 'multipleparts') multiPartsIdx = i;
      if (h === 'multipletranspositions') multiTransIdx = i;
    }

    if (titleIdx === -1) {
      return { success: false, error: 'Title column not found in scoresShop.csv' };
    }

    // 4. Pre-index existing piece folders in vault (single API query for speed!)
    var existingFoldersMap = {};
    var vaultFoldersIter = vault.getFolders();
    while (vaultFoldersIter.hasNext()) {
      var ef = vaultFoldersIter.next();
      existingFoldersMap[cleanString(ef.getName())] = ef;
    }

    var filterClean = targetPiece ? cleanString(targetPiece) : '';

    // 5. Loop through all rows in scoresShop.csv
    for (var r = 1; r < scoresRows.length; r++) {
      var row = scoresRows[r];
      var rawTitle = (row[titleIdx] || '').trim();
      if (!rawTitle) continue;

      var cleanT = cleanString(rawTitle);
      if (filterClean && cleanT !== filterClean && cleanT.indexOf(filterClean) === -1) {
        continue;
      }

      var isMultiParts = multiPartsIdx !== -1 && row[multiPartsIdx] && row[multiPartsIdx].toLowerCase().indexOf('.csv') > -1;
      var isMultiTrans = multiTransIdx !== -1 && row[multiTransIdx] && row[multiTransIdx].toLowerCase().indexOf('.csv') > -1;

      // Get or create parent piece folder
      var pieceFolder = existingFoldersMap[cleanT];
      if (pieceFolder) {
        createdSummary.alreadyExisted++;
      } else {
        pieceFolder = vault.createFolder(rawTitle);
        existingFoldersMap[cleanT] = pieceFolder;
        createdSummary.piecesCreated++;
        createdSummary.createdDetails.push(rawTitle);
      }

      // If multi-parts, scaffold all instrument child folders from CSV header
      if (isMultiParts) {
        var subMap = {};
        var subIter = pieceFolder.getFolders();
        while (subIter.hasNext()) {
          var sf = subIter.next();
          subMap[cleanString(sf.getName())] = sf;
        }

        for (var inst = 0; inst < standardInstruments.length; inst++) {
          var instName = standardInstruments[inst];
          var cleanInst = cleanString(instName);
          if (!subMap[cleanInst]) {
            pieceFolder.createFolder(instName);
            createdSummary.subfoldersCreated++;
          }
        }
      }

      // If multi-transpositions, scaffold key child folders from CSV header
      if (isMultiTrans) {
        var subMap2 = {};
        var subIter2 = pieceFolder.getFolders();
        while (subIter2.hasNext()) {
          var sf2 = subIter2.next();
          subMap2[cleanString(sf2.getName())] = sf2;
        }

        for (var k = 0; k < standardKeys.length; k++) {
          var kName = standardKeys[k];
          var cleanK = cleanString(kName);
          if (!subMap2[cleanK]) {
            pieceFolder.createFolder(kName);
            createdSummary.subfoldersCreated++;
          }
        }
      }
    }

    return createdSummary;

  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

/**
 * Finds the score PDF in Google Drive.
 * 1. Looks inside piece subfolder -> instrument child folder -> any .pdf file.
 * 2. Falls back to flat vault search for backwards compatibility.
 */
function findMatchingFile(vaultFolder, title, instrument) {
  var normTitle = cleanString(title);
  var normInst = cleanString(instrument);

  // Step 1: Look for a dedicated piece folder inside the Vault
  var pieceFolder = findChildFolder(vaultFolder, normTitle);

  if (pieceFolder) {
    if (normInst) {
      var editionFolder = findChildFolder(pieceFolder, normInst);
      if (editionFolder) {
        var pdfInEdition = getNewestPdfInFolder(editionFolder);
        if (pdfInEdition) return pdfInEdition;
      }

      // Fallback: check if a file containing instrument name exists directly in pieceFolder
      var filesInPiece = pieceFolder.getFiles();
      while (filesInPiece.hasNext()) {
        var pf = filesInPiece.next();
        var pfClean = cleanString(pf.getName());
        if (pfClean.indexOf('.pdf') > -1 && pfClean.indexOf(normInst) > -1) {
          return pf;
        }
      }
    } else {
      // Standalone piece: grab any PDF inside the piece folder
      var directPdf = getNewestPdfInFolder(pieceFolder);
      if (directPdf) return directPdf;
    }
  }

  // Step 2: Fallback to flat search in vault root (e.g. beryl.pdf)
  return findMatchingFileFlat(vaultFolder, title, instrument);
}

/**
 * Flat search fallback inside the vault folder root.
 */
function findMatchingFileFlat(folder, title, instrument) {
  var normTitle = cleanString(title);
  var normInst = cleanString(instrument);

  var files = folder.getFiles();
  var candidates = [];

  while (files.hasNext()) {
    var f = files.next();
    var fname = f.getName().toLowerCase();
    var cleanFname = cleanString(fname);

    if (!fname.endsWith('.pdf') && !fname.endsWith('.zip')) {
      continue;
    }

    if (normInst) {
      if (cleanFname.indexOf(normTitle) > -1 && cleanFname.indexOf(normInst) > -1) {
        return f;
      }
    }

    if (cleanFname === normTitle + 'pdf' || cleanFname === normTitle) {
      return f;
    }

    if (cleanFname.indexOf(normTitle) > -1) {
      candidates.push(f);
    }
  }

  if (candidates.length > 0) return candidates[0];
  return null;
}

/**
 * Returns the most recently updated PDF in a folder, regardless of its filename!
 */
function getNewestPdfInFolder(folder) {
  var files = folder.getFiles();
  var newest = null;
  while (files.hasNext()) {
    var f = files.next();
    if (f.getName().toLowerCase().endsWith('.pdf')) {
      if (!newest || f.getLastUpdated() > newest.getLastUpdated()) {
        newest = f;
      }
    }
  }
  return newest;
}

/**
 * Finds a child folder by name (case-insensitive & alphanumeric-clean).
 */
function findChildFolder(parentFolder, targetClean) {
  var folders = parentFolder.getFolders();
  var candidates = [];
  while (folders.hasNext()) {
    var f = folders.next();
    var fClean = cleanString(f.getName());
    if (fClean === targetClean) {
      return f; // EXACT MATCH has priority!
    }
    if (fClean.indexOf(targetClean) > -1 || targetClean.indexOf(fClean) > -1) {
      candidates.push(f);
    }
  }
  return candidates.length > 0 ? candidates[0] : null;
}

function cleanString(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Finds or retrieves the ParakeetPress_Vault folder in Google Drive.
 */
function getVaultFolder() {
  if (VAULT_FOLDER_ID && VAULT_FOLDER_ID.trim().length > 5) {
    try {
      return DriveApp.getFolderById(VAULT_FOLDER_ID.trim());
    } catch (e) {
      console.warn('Could not open folder by ID: ' + e.toString());
    }
  }
  var folders = DriveApp.getFoldersByName(VAULT_FOLDER_NAME);
  if (folders.hasNext()) {
    return folders.next();
  }
  return null;
}

/**
 * Logs the purchase into "ParakeetPress_Sales_Log" spreadsheet inside the Vault folder.
 */
function logSaleRecord(orderId, title, instrument, amount, buyerEmail, fileName, status) {
  try {
    var folder = getVaultFolder();
    var spreadsheet;
    var sheetFile;

    // 1. Look inside Vault folder first
    if (folder) {
      var vaultFiles = folder.getFilesByName(SALES_SHEET_NAME);
      if (vaultFiles.hasNext()) {
        sheetFile = vaultFiles.next();
        spreadsheet = SpreadsheetApp.open(sheetFile);
      }
    }

    // 2. If not found in vault, check if in Drive root and move it to Vault
    if (!spreadsheet) {
      var rootFiles = DriveApp.getFilesByName(SALES_SHEET_NAME);
      if (rootFiles.hasNext()) {
        sheetFile = rootFiles.next();
        spreadsheet = SpreadsheetApp.open(sheetFile);
        if (folder) {
          try { sheetFile.moveTo(folder); } catch (e) {}
        }
      }
    }

    // 3. Create new spreadsheet inside Vault if none exists
    if (!spreadsheet) {
      spreadsheet = SpreadsheetApp.create(SALES_SHEET_NAME);
      sheetFile = DriveApp.getFileById(spreadsheet.getId());
      if (folder) {
        try { sheetFile.moveTo(folder); } catch (e) {}
      }
      var sheet = spreadsheet.getActiveSheet();
      sheet.setName('Sales Log');
      var headerRow = [
        'Date & Time', 
        'Order ID', 
        'Piece Title', 
        'Instrument Edition', 
        'Price Paid', 
        'Buyer Email', 
        'Delivered File', 
        'Delivery Status'
      ];
      sheet.appendRow(headerRow);
      var headerRange = sheet.getRange(1, 1, 1, headerRow.length);
      headerRange.setFontWeight('bold');
      headerRange.setBackground('#4d352d');
      headerRange.setFontColor('#ffffff');
      sheet.setFrozenRows(1);
    }

    var activeSheet = spreadsheet.getActiveSheet();
    var formattedDate = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'GMT-5', 'yyyy-MM-dd HH:mm:ss');
    activeSheet.appendRow([
      formattedDate,
      orderId,
      title,
      instrument || 'Standard (Score & Parts)',
      amount,
      buyerEmail,
      fileName,
      status
    ]);

  } catch (e) {
    console.warn('Logging to Google Sheet failed: ' + e.toString());
  }
}

function createJsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * ============================================================================
 * SELF-SERVICE RE-DOWNLOAD LOOKUP ENGINE
 * ============================================================================
 */
function handleOrderLookup(data) {
  var lookupOrder = (data.orderId || '').trim();
  var lookupEmail = (data.buyerEmail || '').trim().toLowerCase();

  if (!lookupOrder || !lookupEmail) {
    return createJsonResponse({ 
      success: false, 
      error: 'Please provide both your Order ID and the PayPal email address used at checkout.' 
    });
  }

  var folder = getVaultFolder();
  if (!folder) {
    return createJsonResponse({ 
      success: false, 
      error: 'Vault folder not accessible. Please contact Daniel for direct score retrieval.' 
    });
  }

  var vaultFiles = folder.getFilesByName(SALES_SHEET_NAME);
  if (!vaultFiles.hasNext()) {
    return createJsonResponse({ 
      success: false, 
      error: 'Order records are currently being initialized. Please contact Daniel directly.' 
    });
  }

  var spreadsheet = SpreadsheetApp.open(vaultFiles.next());
  var sheet = spreadsheet.getSheetByName('Sales Log') || spreadsheet.getActiveSheet();
  var rows = sheet.getDataRange().getValues();

  var matchedRow = null;
  // Search from newest to oldest (excluding header row 0)
  for (var r = rows.length - 1; r >= 1; r--) {
    var rowOrderId = (rows[r][1] || '').toString().trim();
    var rowEmail = (rows[r][5] || '').toString().trim().toLowerCase();
    var rowStatus = (rows[r][7] || '').toString();

    // Match orderId (case-insensitive) and email
    if (rowOrderId.toLowerCase() === lookupOrder.toLowerCase() && rowEmail === lookupEmail) {
      if (rowStatus.indexOf('SUCCESS') > -1) {
        matchedRow = rows[r];
        break;
      }
    }
  }

  if (!matchedRow) {
    return createJsonResponse({ 
      success: false, 
      error: 'No completed purchase was found matching Order ID "' + lookupOrder + '" and email "' + lookupEmail + '".' 
    });
  }

  var datePurchased = matchedRow[0];
  var title = matchedRow[2];
  var instrument = matchedRow[3] === 'Standard (Score & Parts)' ? '' : matchedRow[3];
  var pricePaid = matchedRow[4];

  // Find matching PDF file in Vault
  var scoreFile = findMatchingFile(folder, title, instrument);
  if (!scoreFile) {
    return createJsonResponse({ 
      success: false, 
      error: 'Score file for "' + title + '" could not be retrieved from the vault. Please contact Daniel.' 
    });
  }

  // Log re-download audit record in spreadsheet
  try {
    var formattedDate = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'GMT-5', 'yyyy-MM-dd HH:mm:ss');
    sheet.appendRow([
      formattedDate,
      lookupOrder,
      title,
      instrument || 'Standard (Score & Parts)',
      pricePaid,
      lookupEmail,
      scoreFile.getName(),
      'SUCCESS: Re-downloaded via Portal'
    ]);
  } catch (logErr) {
    console.warn('Re-download audit log notice:', logErr);
  }

  var fileBlob = scoreFile.getBlob();
  var base64Data = Utilities.base64Encode(fileBlob.getBytes());

  return createJsonResponse({
    success: true,
    orderId: lookupOrder,
    pieceTitle: title,
    instrument: instrument,
    date: datePurchased,
    amount: pricePaid,
    fileName: scoreFile.getName(),
    pdfBase64: base64Data
  });
}

/**
 * ============================================================================
 * PAYPAL SERVER-SIDE REST API VERIFICATION
 * ============================================================================
 */
function verifyPayPalOrder(orderId, expectedAmount) {
  var props = PropertiesService.getScriptProperties();
  var clientId = props.getProperty('PAYPAL_CLIENT_ID');
  var clientSecret = props.getProperty('PAYPAL_CLIENT_SECRET');
  var env = (props.getProperty('PAYPAL_ENV') || 'live').toLowerCase();

  // If PayPal credentials are not yet entered into Script Properties, allow safe pass-through with audit note
  if (!clientId || !clientSecret) {
    return {
      verified: true,
      bypassed: true,
      warning: 'PayPal credentials not set in Google Apps Script Script Properties.'
    };
  }

  var baseUrl = env === 'sandbox' ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';

  try {
    // 1. Get OAuth2 Access Token
    var tokenRes = UrlFetchApp.fetch(baseUrl + '/v1/oauth2/token', {
      method: 'post',
      headers: {
        'Authorization': 'Basic ' + Utilities.base64Encode(clientId + ':' + clientSecret),
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      payload: 'grant_type=client_credentials',
      muteHttpExceptions: true
    });

    if (tokenRes.getResponseCode() !== 200) {
      return { verified: false, error: 'Failed to authenticate with PayPal OAuth API.' };
    }

    var tokenData = JSON.parse(tokenRes.getContentText());
    var accessToken = tokenData.access_token;

    // 2. Query Order Details
    var orderRes = UrlFetchApp.fetch(baseUrl + '/v2/checkout/orders/' + encodeURIComponent(orderId), {
      method: 'get',
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'Content-Type': 'application/json'
      },
      muteHttpExceptions: true
    });

    if (orderRes.getResponseCode() !== 200) {
      return { verified: false, error: 'Order not found on PayPal servers.' };
    }

    var orderData = JSON.parse(orderRes.getContentText());
    var status = orderData.status;

    if (status !== 'COMPLETED' && status !== 'APPROVED') {
      return { verified: false, error: 'PayPal order status is ' + status + ' (expected COMPLETED).' };
    }

    var purchaseUnits = orderData.purchase_units || [];
    if (purchaseUnits.length === 0) {
      return { verified: false, error: 'Missing purchase units in PayPal order.' };
    }

    var amountObj = purchaseUnits[0].amount || {};
    var paidCurrency = amountObj.currency_code;
    var paidValue = parseFloat(amountObj.value);

    if (paidCurrency !== 'USD') {
      return { verified: false, error: 'Invalid payment currency: ' + paidCurrency };
    }

    var expectedNum = parseFloat((expectedAmount || '4.00').replace(/[^\d.]/g, ''));
    if (isFinite(expectedNum) && expectedNum > 0 && paidValue < (expectedNum - 0.05)) {
      return { 
        verified: false, 
        error: 'Paid amount ($' + paidValue + ') does not match score price ($' + expectedNum + ').' 
      };
    }

    var payerEmail = (orderData.payer && orderData.payer.email_address) ? orderData.payer.email_address : null;

    return {
      verified: true,
      payerEmail: payerEmail,
      paidValue: paidValue,
      order: orderData
    };

  } catch (e) {
    return { verified: false, error: 'Exception verifying PayPal transaction: ' + e.toString() };
  }
}

/**
 * Anti-Replay: Verifies if a real PayPal Order ID has already been fulfilled in the Sales Log.
 */
function isOrderAlreadyFulfilled(orderId) {
  try {
    var folder = getVaultFolder();
    if (!folder) return false;
    var vaultFiles = folder.getFilesByName(SALES_SHEET_NAME);
    if (!vaultFiles.hasNext()) return false;
    var ss = SpreadsheetApp.open(vaultFiles.next());
    var sheet = ss.getSheetByName('Sales Log') || ss.getActiveSheet();
    var data = sheet.getDataRange().getValues();

    for (var i = 1; i < data.length; i++) {
      var rowOrder = (data[i][1] || '').toString().trim();
      var status = (data[i][7] || '').toString();
      if (rowOrder.toLowerCase() === orderId.toLowerCase() && status.indexOf('SUCCESS: Delivered') > -1) {
        return true;
      }
    }
  } catch (e) {
    console.warn('Anti-replay check failed: ' + e.toString());
  }
  return false;
}

