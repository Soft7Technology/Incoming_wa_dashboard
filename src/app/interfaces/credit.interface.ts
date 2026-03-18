export interface CreditTransaction {
  id: string;
  company_id: string;
  type: 'credit' | 'debit' | 'refund';
  amount: number;
  balance_before: number;
  balance_after: number;
  reference_type?: string;
  reference_id?: string;
  description?: string;
  created_by?: string;
  meta_data?: any;
  created_at: Date;
}

export interface AddCreditDto {
  company_id: string;
  amount: number;
  description?: string;
  created_by: string;
}

export interface DeductCreditDto {
  company_id: string;
  amount: number;
  reference_type: string;
  reference_id: string;
  description?: string;
}

export interface CreditBalance {
  company_id: string;
  balance: number;
  last_transaction?: CreditTransaction;
}
