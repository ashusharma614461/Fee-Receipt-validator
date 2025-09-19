
export interface StudentData {
  userId: string;
  name: string;
  amount: string;
  campusName: string;
  paymentDate: string;
  utr: string;
}

export interface CsvRow {
  [key: string]: string;
}

export interface ProcessingResult {
  originalData: CsvRow;
  validation?: ValidationResponse;
  error?: string;
  timestamp: string;
}

export interface ExtractedInformation {
  Student_Name: string;
  Amount: string;
  Campus: string;
  Payment_Date: string;
  Transaction_Details: string;
  Reference_Number: string;
  Proof_Type: 'UPI' | 'Cheque' | 'Bank Slip' | 'Campus Receipt' | 'Unknown';
  Logo_Present: boolean;
  Stamp_Present: boolean;
}

export interface ValidationResponse {
  Extracted_Information: ExtractedInformation;
  Validation_Status: 'Receipt Validated' | 'Mismatch Found' | 'Not Readable – Human Review Required';
  Observations: string;
}
