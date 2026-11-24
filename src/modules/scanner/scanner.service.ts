import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { DatabaseService } from '../../db/database.service';
import { getIstDateString } from '../../common/ist-date.util';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse = require('pdf-parse');

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
  rawText?: string;
}

@Injectable()
export class ScannerService {
  private readonly logger = new Logger(ScannerService.name);

  constructor(private readonly db: DatabaseService) {}

  /**
   * Parse Parivahan PUC Certificate PDF buffer
   */
  async parsePdfBuffer(buffer: Buffer): Promise<ExtractedPucData> {
    if (!buffer || buffer.length === 0) {
      throw new BadRequestException('Empty PDF file uploaded');
    }

    try {
      const parsed = await pdfParse(buffer);
      const rawText = parsed.text || '';
      const extracted = this.parseParivahanText(rawText);
      extracted.rawText = rawText.slice(0, 500); // provide excerpt for verification
      return extracted;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to parse PDF: ${msg}`);
      throw new BadRequestException(`Could not parse PDF document: ${msg}`);
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
          params.get('validity') ||
          '';

        let issueDate =
          params.get('issue') ||
          params.get('test_date') ||
          params.get('date') ||
          '';

        let fuelType = params.get('fuel') || params.get('fuel_type') || '';
        let vehicleType = params.get('class') || params.get('type') || '';

        // If some parameters were not in standard query params, search inside the entire URL string
        if (!regNumber) {
          const regMatch = trimmed.match(/[A-Z]{2}[0-9]{1,2}[A-Z]{1,3}[0-9]{4}/i);
          if (regMatch) regNumber = regMatch[0];
        }

        // Clean & format
        regNumber = this.normalizeRegNumber(regNumber);
        expiryDate = this.normalizeDateString(expiryDate);
        issueDate = this.normalizeDateString(issueDate);
        fuelType = this.normalizeFuelType(fuelType);
        vehicleType = this.normalizeVehicleType(vehicleType);

        // Date defaults if missing
        const dates = this.computeDefaultDates(issueDate, expiryDate, fuelType);

        return {
          regNumber,
          certificateNumber: certificateNumber.trim(),
          issueDate: dates.issueDate,
          expiryDate: dates.expiryDate,
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
      let issueDate = '';
      let expiryDate = '';
      let fuelType = 'Petrol';
      let vehicleType = '4-Wheeler';

      for (const part of parts) {
        if (!regNumber && /[A-Z]{2}[-\s]?[0-9]{1,2}[-\s]?[A-Z]{0,3}[-\s]?[0-9]{4}/i.test(part)) {
          regNumber = this.normalizeRegNumber(part);
        } else if (!certificateNumber && /^[A-Z0-9]{8,20}$/i.test(part) && !/PETROL|DIESEL|CNG/i.test(part)) {
          certificateNumber = part.toUpperCase();
        } else if (!issueDate && /\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}/.test(part)) {
          issueDate = this.normalizeDateString(part);
        } else if (!expiryDate && /\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}/.test(part)) {
          expiryDate = this.normalizeDateString(part);
        } else if (/PETROL|DIESEL|CNG|ELECTRIC/i.test(part)) {
          fuelType = this.normalizeFuelType(part);
        }
      }

      const dates = this.computeDefaultDates(issueDate, expiryDate, fuelType);

      return {
        regNumber,
        certificateNumber,
        issueDate: dates.issueDate,
        expiryDate: dates.expiryDate,
        fuelType,
        vehicleType,
        rawText: trimmed,
      };
    }

    // Case 3: Fallback unstructured text parsing
    return this.parseParivahanText(trimmed);
  }

  /**
   * Parse plain text from Parivahan PUC certificate document
   */
  parseParivahanText(rawText: string): ExtractedPucData {
    const clean = rawText.replace(/\r/g, '');

    // 1. Vehicle Registration Number
    const regLabelMatch = clean.match(
      /(?:Registration\s*No|Vehicle\s*Reg\s*No|Vehicle\s*No|Regn\s*No|Reg\s*No)[\s:.\-]+([A-Z]{2}[-\s]?[0-9]{1,2}[-\s]?[A-Z]{0,3}[-\s]?[0-9]{4})/i,
    );
    const regBareMatch = clean.match(/\b([A-Z]{2}[-\s]?[0-9]{1,2}[-\s]?[A-Z]{1,3}[-\s]?[0-9]{4})\b/i);
    const regRaw = regLabelMatch ? regLabelMatch[1] : regBareMatch ? regBareMatch[1] : '';
    const regNumber = this.normalizeRegNumber(regRaw);

    // 2. Certificate Number
    const certMatch =
      clean.match(/(?:Certificate\s*No|PUC\s*Certificate\s*No|PUCC\s*No)[\s:.\-]+([A-Z0-9]{8,22})/i) ||
      clean.match(/\b([A-Z]{2}[0-9]{8,18})\b/i);
    const certificateNumber = certMatch ? certMatch[1].trim().toUpperCase() : '';

    // 3. Expiry Date (Valid Upto)
    const validMatch = clean.match(
      /(?:Valid\s*Upto|Validity\s*Upto|Valid\s*Till|Expiry\s*Date|Valid\s*To)[\s:.\-]+(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})/i,
    );
    let expiryDate = validMatch ? this.normalizeDateString(validMatch[1]) : '';

    // 4. Issue Date (Date of Testing)
    const testMatch = clean.match(
      /(?:Date\s*of\s*Testing|Date\s*of\s*Issue|Test\s*Date|Issue\s*Date|Tested\s*On)[\s:.\-]+(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})/i,
    );
    let issueDate = testMatch ? this.normalizeDateString(testMatch[1]) : '';

    // 5. Fuel Type
    const fuelMatch = clean.match(/(?:Fuel(?:\s*Type)?)[\s:.\-]+([^\n\r,]+)/i);
    const fuelRaw = fuelMatch ? fuelMatch[1] : clean;
    const fuelType = this.normalizeFuelType(fuelRaw);

    // 6. Vehicle Class / Type
    const classMatch = clean.match(/(?:Vehicle\s*Class|Class\s*of\s*Vehicle|Vehicle\s*Type)[\s:.\-]+([^\n\r,]+)/i);
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
    const nameMatch = clean.match(/(?:Owner\s*Name|Customer\s*Name|Name\s*of\s*Owner)[\s:.\-]+([^\n\r,]+)/i);
    const fullName = nameMatch ? nameMatch[1].trim().replace(/\s+/g, ' ') : '';

    // 9. Mobile Number
    const mobileMatch = clean.match(/(?:Mobile(?:\s*No)?|Phone(?:\s*No)?)[\s:.\-]+([6-9]\d{9})\b/i);
    const mobileNumber = mobileMatch ? mobileMatch[1].trim() : '';

    // Default dates if one is missing
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

  // --- Helper normalization functions ---

  private normalizeRegNumber(raw: string): string {
    if (!raw) return '';
    return raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  }

  private normalizeDateString(dStr: string): string {
    if (!dStr) return '';
    const m = dStr.match(/(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})/);
    if (!m) return '';
    const day = m[1].padStart(2, '0');
    const month = m[2].padStart(2, '0');
    let year = m[3];
    if (year.length === 2) {
      year = '20' + year;
    }
    return `${year}-${month}-${day}`;
  }

  private normalizeFuelType(raw: string): string {
    if (/CNG/i.test(raw)) return 'CNG';
    if (/DIESEL/i.test(raw)) return 'Diesel';
    if (/ELECTRIC|EV/i.test(raw)) return 'Electric';
    return 'Petrol';
  }

  private normalizeVehicleType(raw: string): string {
    if (/2\s*Wheeler|Motor\s*Cycle|Scooter|Moped|Two\s*Wheeler/i.test(raw)) return '2-Wheeler';
    if (/Goods|Commercial|Heavy|Transport|HGV|Truck|Bus|Tractor/i.test(raw)) return 'Commercial';
    if (/3\s*Wheeler|Auto|Rickshaw/i.test(raw)) return 'Other';
    return '4-Wheeler';
  }

  private computeDefaultDates(
    issueDate?: string,
    expiryDate?: string,
    fuelType?: string,
  ): { issueDate: string; expiryDate: string } {
    const today = getIstDateString();

    if (!issueDate && !expiryDate) {
      // Default issue today, expiry +1 year
      const exp = new Date(today);
      exp.setFullYear(exp.getFullYear() + 1);
      return { issueDate: today, expiryDate: exp.toISOString().slice(0, 10) };
    }

    if (issueDate && !expiryDate) {
      const exp = new Date(issueDate);
      // Petrol/CNG typically 1 year, Commercial / older 6 months
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
