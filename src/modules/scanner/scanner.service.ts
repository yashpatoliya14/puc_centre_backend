import { Injectable, Logger, BadRequestException, OnModuleDestroy } from '@nestjs/common';
import { createWorker, type Worker as TesseractWorker } from 'tesseract.js';
import { getIstDateString } from '../../common/ist-date.util';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PDFParse } = require('pdf-parse') as {
  PDFParse: new (opts: { data: Uint8Array | Buffer }) => {
    getText: (params?: { cellSeparator?: string; lineEnforce?: boolean }) => Promise<{ text?: string }>;
    getScreenshot: (params?: { scale?: number; first?: number; imageBuffer?: boolean }) => Promise<{
      pages?: Array<{ data?: Uint8Array }>;
    }>;
    destroy: () => Promise<void>;
  };
};

export interface ExtractedPucData {
  regNumber: string;
  certificateNumber?: string;
  issueDate?: string;
  expiryDate?: string;
  fuelType?: 'Petrol' | 'Diesel' | 'CNG' | 'Electric' | string;
  vehicleType?: '2-Wheeler' | '4-Wheeler' | 'Commercial' | 'Other' | string;
  makeModel?: string;
  fullName?: string;
  mobileNumber?: string;
  insuranceCompany?: string;
  insuranceExpiry?: string;
  rawText?: string;
}

@Injectable()
export class ScannerService implements OnModuleDestroy {
  private readonly logger = new Logger(ScannerService.name);
  private ocrWorker: TesseractWorker | null = null;
  private ocrQueue: Promise<unknown> = Promise.resolve();

  async onModuleDestroy(): Promise<void> {
    if (this.ocrWorker) {
      await this.ocrWorker.terminate().catch(() => {});
      this.ocrWorker = null;
    }
  }

  private async getOcrWorker(): Promise<TesseractWorker> {
    if (!this.ocrWorker) {
      this.ocrWorker = await createWorker('eng');
    }
    return this.ocrWorker;
  }

  private recognizeImageBuffer(buffer: Buffer): Promise<string> {
    const task = this.ocrQueue.then(async () => {
      const worker = await this.getOcrWorker();
      const result = await worker.recognize(buffer);
      return result?.data?.text || '';
    });
    this.ocrQueue = task.catch(() => {});
    return task;
  }

  /**
   * Parse Parivahan PUC Certificate PDF buffer (supports both text PDFs and scanned PDFs via OCR)
   */
  async parsePdfBuffer(buffer: Buffer): Promise<ExtractedPucData> {
    if (!buffer || buffer.length === 0) {
      throw new BadRequestException('Empty PDF file uploaded');
    }

    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try {
      const parsed = await parser.getText({ cellSeparator: '  ', lineEnforce: true });
      let rawText = parsed?.text || '';

      // Fallback for scanned / image-only PDFs where embedded text is absent
      if (rawText.replace(/\s+/g, '').length < 25) {
        try {
          const shot = await parser.getScreenshot({ scale: 2, first: 1, imageBuffer: true });
          const pageImg = shot?.pages?.[0]?.data;
          if (pageImg && pageImg.length > 0) {
            const ocrText = await this.recognizeImageBuffer(Buffer.from(pageImg));
            if (ocrText.trim().length > rawText.trim().length) {
              rawText = ocrText;
            }
          }
        } catch (ocrErr) {
          this.logger.warn(
            `Scanned PDF OCR fallback failed: ${ocrErr instanceof Error ? ocrErr.message : String(ocrErr)}`,
          );
        }
      }

      const extracted = this.parseParivahanText(rawText);
      extracted.rawText = rawText.slice(0, 500);
      return extracted;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to parse PDF: ${msg}`);
      throw new BadRequestException(`Could not parse PDF document: ${msg}`);
    } finally {
      await parser.destroy().catch(() => {});
    }
  }

  /**
   * Extract PUC certificate details from an uploaded image buffer using OCR
   */
  async parseImageBuffer(buffer: Buffer): Promise<ExtractedPucData> {
    if (!buffer || buffer.length === 0) {
      throw new BadRequestException('Empty image file uploaded');
    }

    try {
      const rawText = await this.recognizeImageBuffer(buffer);
      const extracted = this.parseParivahanText(rawText);
      extracted.rawText = rawText.slice(0, 500);
      return extracted;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to OCR image: ${msg}`);
      throw new BadRequestException(`Could not read text from image: ${msg}`);
    }
  }

  /**
   * Parse Parivahan QR code string (URL, delimited tokens, or unstructured text)
   */
  parseQrString(qrText: string): ExtractedPucData {
    if (!qrText || typeof qrText !== 'string' || !qrText.trim()) {
      throw new BadRequestException('Empty QR text provided');
    }

    const trimmed = qrText.trim();

    // Case 1: Verification URL (e.g. https://vahan.parivahan.gov.in/puc/verify?doc=...&v=...)
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      try {
        const url = new URL(trimmed);
        const params = url.searchParams;

        let regNumber =
          params.get('v') ||
          params.get('regn_no') ||
          params.get('vehno') ||
          params.get('regNo') ||
          params.get('reg') ||
          '';

        const certificateNumber =
          params.get('doc') ||
          params.get('cert_no') ||
          params.get('certNo') ||
          params.get('cert') ||
          params.get('pucno') ||
          '';

        let expiryDate =
          params.get('exp') ||
          params.get('valid_upto') ||
          params.get('validUpto') ||
          params.get('upto') ||
          params.get('validity') ||
          params.get('expiry') ||
          params.get('expiry_date') ||
          params.get('valid_till') ||
          params.get('pucc_upto') ||
          params.get('vahan_upto') ||
          '';

        let issueDate =
          params.get('issue') ||
          params.get('test_date') ||
          params.get('issue_date') ||
          params.get('date') ||
          '';

        let fuelType = params.get('fuel') || params.get('fuel_type') || '';
        let vehicleType = params.get('class') || params.get('type') || '';

        if (!regNumber) {
          const regMatch = trimmed.match(/[A-Z]{2}[0-9]{1,2}[A-Z]{1,3}[0-9]{4}/i);
          if (regMatch) regNumber = regMatch[0];
        }

        regNumber = this.normalizeRegNumber(regNumber);
        expiryDate = this.normalizeDateString(expiryDate);
        issueDate = this.normalizeDateString(issueDate);
        fuelType = this.normalizeFuelType(fuelType);
        vehicleType = this.normalizeVehicleType(vehicleType);

        // Do not invent a synthetic expiryDate if the QR URL did not contain one
        return {
          regNumber,
          certificateNumber: certificateNumber.trim(),
          issueDate,
          expiryDate,
          fuelType,
          vehicleType,
          rawText: trimmed,
        };
      } catch {
        // Fallback to text parsing
      }
    }

    // Case 2: Pipe or semicolon delimited string
    // e.g. GJ01AB1234|GJ010040003421|24-11-2026|23-11-2027|PETROL
    if (trimmed.includes('|') || trimmed.includes(';')) {
      const parts = trimmed.split(/[|;]/).map((p) => p.trim());
      let regNumber = '';
      let certificateNumber = '';
      const foundDates: string[] = [];
      let fuelType = 'Petrol';
      const vehicleType = '4-Wheeler';

      for (const part of parts) {
        if (!regNumber && /[A-Z]{2}[-\s]?[0-9]{1,2}[-\s]?[A-Z]{0,3}[-\s]?[0-9]{4}/i.test(part)) {
          regNumber = this.normalizeRegNumber(part);
        } else if (!certificateNumber && /^[A-Z0-9]{8,20}$/i.test(part) && !/PETROL|DIESEL|CNG/i.test(part)) {
          certificateNumber = part.toUpperCase();
        } else {
          const d = this.normalizeDateString(part);
          if (d) {
            foundDates.push(d);
          } else if (/PETROL|DIESEL|CNG|ELECTRIC/i.test(part)) {
            fuelType = this.normalizeFuelType(part);
          }
        }
      }

      foundDates.sort();
      const issueDate = foundDates.length >= 2 ? foundDates[0] : '';
      const expiryDate = foundDates.length >= 1 ? foundDates[foundDates.length - 1] : '';

      return {
        regNumber,
        certificateNumber,
        issueDate,
        expiryDate,
        fuelType,
        vehicleType,
        rawText: trimmed,
      };
    }

    // Case 3: Fallback unstructured text parsing
    return this.parseParivahanText(trimmed);
  }

  /**
   * Parse plain text from Parivahan PUC certificate document or OCR output
   */
  parseParivahanText(rawText: string): ExtractedPucData {
    const clean = rawText.replace(/\r/g, '');
    const datePattern =
      '(\\d{4}\\s*[\\/\\-\\.]\\s*\\d{1,2}\\s*[\\/\\-\\.]\\s*\\d{1,2}|\\d{1,2}[\\s\\-\\.\\/]+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*[\\s\\-\\.\\/,]+\\d{2,4}|\\d{1,2}\\s*[\\/\\-\\.]\\s*\\d{1,2}\\s*[\\/\\-\\.]\\s*\\d{2,4})';

    // 1. Vehicle Registration Number (handles OCR lookalikes like O->0 in RTO digits, never spans newlines)
    const regLabelMatch = clean.match(
      /(?:Vehicle\s*Registration\s*No\.?|Registration\s*No\.?|Registration\s*Number|Vehicle\s*Reg\s*No\.?|Vehicle\s*No\.?|Regn\.?\s*No\.?|Reg\.?\s*No\.?)[\s:.\-\n]+([A-Z]{2}[- ]?[0-9OQDIlZSB]{1,2}[- ]?[A-Z0-9]{0,3}[- ]?[0-9OQDIlZSB]{4})\b/i,
    );
    const regBareMatch = clean.match(
      /\b([A-Z]{2}[- ]?[0-9OQDIlZSB]{1,2}[- ]?[A-Z0-9]{1,3}[- ]?[0-9OQDIlZSB]{4})\b/i,
    );
    const regRaw = regLabelMatch ? regLabelMatch[1] : regBareMatch ? regBareMatch[1] : '';
    const regNumber = this.normalizeRegNumber(regRaw);

    // 2. Certificate Number
    const certMatch =
      clean.match(
        /(?:Certificate\s*(?:SL\.?|Serial)?\s*No\.?|PUC\s*Certificate\s*No\.?|PUCC\s*No\.?|Serial\s*No\.?)[\s:.\-]+([A-Z0-9\/\-]{6,26})/i,
      ) || clean.match(/\b([A-Z]{2}[0-9]{8,18})\b/i);
    const certificateNumber = certMatch ? certMatch[1].trim().toUpperCase() : '';

    // 3. Expiry Date (Valid Upto / Valid up to / Validity / Expiry)
    const validMatch = clean.match(
      new RegExp(
        `(?:PUCC\\s*Valid\\s*up\\s*to|Certificate\\s*Valid\\s*up\\s*to|Valid\\s*up\\s*to|Validity\\s*up\\s*to|Valid\\s*Till|Valid\\s*Until|Valid\\s*To|Expiry\\s*Date|Date\\s*of\\s*Expiry|Validity|Expiry)[^\\d\\n]{0,25}${datePattern}`,
        'i',
      ),
    );
    let expiryDate = validMatch ? this.normalizeDateString(validMatch[1]) : '';

    // 4. Issue Date (Date of Testing or standalone Date line)
    const testMatch = clean.match(
      new RegExp(
        `(?:Date\\s*(?:&\\s*Time\\s*)?of\\s*Testing|Date\\s*of\\s*Issue|Testing\\s*Date|Test\\s*Date|Issue\\s*Date|Tested\\s*On|(?:^|\\n)\\s*Date(?!\\s*of\\s*Registration))[^\\d\\n]{0,25}${datePattern}`,
        'i',
      ),
    );
    let issueDate = testMatch ? this.normalizeDateString(testMatch[1]) : '';

    // 4B. Two-column PDF / OCR fallback: collect all candidate dates excluding Registration / Mfg dates
    if (!expiryDate || !issueDate) {
      const globalDateRegex = new RegExp(datePattern, 'gi');
      const candidateDates: string[] = [];
      for (const line of clean.split('\n')) {
        if (
          /Date\s*of\s*Registration|Registration\s*Date|Manufacturing|Mfg|Birth|DOB|Printed\s*On|Print\s*Date|Generated\s*On|Downloaded\s*On/i.test(
            line,
          )
        ) {
          continue;
        }
        let m: RegExpExecArray | null;
        while ((m = globalDateRegex.exec(line)) !== null) {
          const parsedDate = this.normalizeDateString(m[1]);
          if (parsedDate) candidateDates.push(parsedDate);
        }
      }
      const uniqueSorted = Array.from(new Set(candidateDates)).sort();
      if (!expiryDate && uniqueSorted.length > 0) {
        if (issueDate) {
          const later = uniqueSorted.filter((d) => d > issueDate);
          if (later.length > 0) expiryDate = later[later.length - 1];
        } else if (uniqueSorted.length >= 2) {
          issueDate = uniqueSorted[0];
          expiryDate = uniqueSorted[uniqueSorted.length - 1];
        } else {
          expiryDate = uniqueSorted[0];
        }
      } else if (!issueDate && uniqueSorted.length > 0 && expiryDate) {
        const earlier = uniqueSorted.filter((d) => d < expiryDate);
        if (earlier.length > 0) issueDate = earlier[earlier.length - 1];
      }
    }

    // 5. Fuel Type
    const fuelMatch = clean.match(/(?:Fuel(?:\s*Type|\s*Used)?)[\s:.\-]+([^\n\r,]+)/i);
    const fuelRaw = fuelMatch ? fuelMatch[1] : clean;
    const fuelType = this.normalizeFuelType(fuelRaw);

    // 6. Vehicle Class / Type
    const classMatch = clean.match(
      /(?:Vehicle\s*Category|Vehicle\s*Class|Class\s*of\s*Vehicle|Vehicle\s*Type)[\s:.\-]+([^\n\r,]+)/i,
    );
    const vehicleType = this.normalizeVehicleType(classMatch ? classMatch[1] : clean);

    // 7. Make / Model
    const makeMatch = clean.match(/(?:Make(?:\s*Name)?)[\s:.\-]+([^\n\r,]+)/i);
    const modelMatch = clean.match(/(?:Model(?:\s*Name)?)[\s:.\-]+([^\n\r,]+)/i);
    let makeModel = '';
    if (makeMatch && modelMatch) {
      makeModel = `${makeMatch[1].trim()} ${modelMatch[1].trim()}`;
    } else if (modelMatch) {
      makeModel = modelMatch[1].trim();
    } else if (makeMatch) {
      makeModel = makeMatch[1].trim();
    }

    // 8. Owner Name
    const nameMatch = clean.match(
      /(?:Owner\s*Name|Registered\s*Owner|Customer\s*Name|Name\s*of\s*Owner)[\s:.\-]+([^\n\r,]+)/i,
    );
    const fullName = nameMatch ? nameMatch[1].trim().replace(/\s+/g, ' ') : '';

    // 9. Mobile Number
    const mobileMatch = clean.match(
      /(?:Mobile(?:\s*No\.?|\s*Number)?|Phone(?:\s*No\.?)?|Contact(?:\s*No\.?)?)[\s:.\-]+(?:\+?91[\s\-]?|0)?([6-9]\d{9})\b/i,
    );
    const mobileNumber = mobileMatch ? mobileMatch[1].trim() : '';

    const dates = this.computeDefaultDates(issueDate, expiryDate, fuelType);

    return {
      regNumber,
      certificateNumber,
      issueDate: dates.issueDate,
      expiryDate: dates.expiryDate,
      fuelType,
      vehicleType,
      makeModel,
      fullName,
      mobileNumber,
      rawText: clean.slice(0, 300),
    };
  }

  private normalizeRegNumber(raw: string): string {
    if (!raw) return '';
    const cleaned = raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    if (cleaned.length < 6 || cleaned.length > 12) return cleaned;

    const toDigit = (ch: string) =>
      ({ O: '0', Q: '0', D: '0', I: '1', L: '1', Z: '2', S: '5', B: '8' }[ch] || ch);
    const toLetter = (ch: string) => ({ '0': 'O', '1': 'I', '5': 'S', '8': 'B' }[ch] || ch);

    // Standard Indian plate: 2 state letters + 1-2 district digits + 1-3 series letters + 4 trailing digits
    const m = cleaned.match(/^([A-Z0-9]{2})([A-Z0-9]{1,2})([A-Z0-9]{0,3})([A-Z0-9]{4})$/);
    if (m) {
      const state = m[1].split('').map(toLetter).join('');
      const rto = m[2].split('').map(toDigit).join('');
      const series = m[3].split('').map(toLetter).join('');
      const num = m[4].split('').map(toDigit).join('');
      const candidate = `${state}${rto}${series}${num}`;
      if (/^[A-Z]{2}[0-9]{1,2}[A-Z]{0,3}[0-9]{4}$/.test(candidate)) {
        return candidate;
      }
    }
    return cleaned;
  }

  private normalizeDateString(dStr: string): string {
    if (!dStr) return '';
    const trimmed = dStr.replace(/\s*([\/\-\.])\s*/g, '$1').trim();

    const formatValid = (y: string, m: string, d: string): string => {
      let monthNum = Number(m);
      let dayNum = Number(d);
      if (monthNum > 12 && dayNum <= 12) {
        [monthNum, dayNum] = [dayNum, monthNum];
      }
      if (monthNum < 1 || monthNum > 12 || dayNum < 1 || dayNum > 31) return '';
      return `${y}-${String(monthNum).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;
    };

    // YYYY-MM-DD or YYYY/MM/DD
    const isoMatch = trimmed.match(/^(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})$/);
    if (isoMatch) {
      return formatValid(isoMatch[1], isoMatch[2], isoMatch[3]);
    }

    // DD-MMM-YYYY or DD MMM YYYY (e.g. 08-Dec-2027)
    const monthMap: Record<string, string> = {
      jan: '01',
      feb: '02',
      mar: '03',
      apr: '04',
      may: '05',
      jun: '06',
      jul: '07',
      aug: '08',
      sep: '09',
      sept: '09',
      oct: '10',
      nov: '11',
      dec: '12',
    };
    const textMonthMatch = trimmed.match(
      /^(\d{1,2})[\s\-\.\/]+([A-Za-z]{3,9})[\s\-\.\/,]+(\d{2,4})$/,
    );
    if (textMonthMatch) {
      const mKey = textMonthMatch[2].toLowerCase().slice(0, 4);
      const month = monthMap[mKey] || monthMap[textMonthMatch[2].toLowerCase().slice(0, 3)];
      if (month) {
        let year = textMonthMatch[3];
        if (year.length === 2) year = '20' + year;
        return formatValid(year, month, textMonthMatch[1]);
      }
    }

    // DD/MM/YYYY or DD-MM-YYYY
    const m = trimmed.match(/(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})/);
    if (!m) return '';
    let year = m[3];
    if (year.length === 2) {
      year = '20' + year;
    }
    return formatValid(year, m[2], m[1]);
  }

  private normalizeFuelType(raw: string): string {
    if (/CNG/i.test(raw)) return 'CNG';
    if (/DIESEL/i.test(raw)) return 'Diesel';
    if (/ELECTRIC|\bEV\b/i.test(raw)) return 'Electric';
    return 'Petrol';
  }

  private normalizeVehicleType(raw: string): string {
    if (/2\s*[-\s]?Wheeler|\b2W\b|Motor\s*Cycle|MCWG|MCWOG|Scooter|Moped|Two\s*Wheeler/i.test(raw)) {
      return '2-Wheeler';
    }
    if (/Goods|Commercial|Heavy|Transport|HGV|LCV|HCV|LGV|MGV|Truck|Bus|Tractor/i.test(raw)) {
      return 'Commercial';
    }
    if (/3\s*[-\s]?Wheeler|\b3W\b|Auto|Rickshaw/i.test(raw)) {
      return 'Other';
    }
    return '4-Wheeler';
  }

  private computeDefaultDates(
    issueDate?: string,
    expiryDate?: string,
    _fuelType?: string,
  ): { issueDate: string; expiryDate: string } {
    const today = getIstDateString();

    if (!issueDate && !expiryDate) {
      const exp = new Date(today);
      exp.setFullYear(exp.getFullYear() + 1);
      return { issueDate: today, expiryDate: exp.toISOString().slice(0, 10) };
    }

    if (issueDate && !expiryDate) {
      const exp = new Date(issueDate);
      exp.setFullYear(exp.getFullYear() + 1);
      return { issueDate, expiryDate: exp.toISOString().slice(0, 10) };
    }

    if (!issueDate && expiryDate) {
      const iss = new Date(expiryDate);
      iss.setFullYear(iss.getFullYear() - 1);
      return { issueDate: iss.toISOString().slice(0, 10), expiryDate };
    }

    return { issueDate: issueDate || today, expiryDate: expiryDate || today };
  }
}
