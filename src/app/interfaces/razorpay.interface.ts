export interface RazorpayOrderRequest {
  amount: number;
  currency: string;
  receipt: string;
  notes: {
    userId: string;
    planId: string;
    planName: string;
  };
}