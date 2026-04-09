// Relay Platform — Job Passport type definitions

export type Stage = 'intake' | 'measure' | 'quote' | 'install' | 'invoice' | 'complete';

export type PreferredChannel = 'sms' | 'email';

export type QuoteStatus = 'draft' | 'sent' | 'approved' | 'rejected';

export type ProofPhotoType = 'before' | 'during' | 'after';

export type ExceptionType =
  | 'sla_breach'
  | 'proof_missing'
  | 'no_response'
  | 'change_order'
  | 'stage_stall'
  | 'unassigned';

export type ExceptionSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface StageEvent {
  id: string;
  stage: Stage;
  timestamp: Date;
  actor: string;
  notes?: string;
  automated: boolean;
}

export interface QuoteVersion {
  id: string;
  createdAt: Date;
  amount: number;
  scope: string;
  status: QuoteStatus;
  changeOrderAmount?: number;
}

export interface ProofPhoto {
  id: string;
  url: string;
  type: ProofPhotoType;
  capturedAt: Date;
}

export interface Exception {
  id: string;
  type: ExceptionType;
  severity: ExceptionSeverity;
  detectedAt: Date;
  resolvedAt?: Date;
  resolution?: string;
  escalatedTo?: string;
  notifiedAt?: Date;
}

export interface Retailer {
  name: string;
  contactNumber: string;
  jobRefFormat?: string;
  preferredChannel: PreferredChannel;
  sourceNumber: string;
}

export interface Customer {
  name: string;
  address: string;
  phone: string;
  email?: string;
}

export interface Scope {
  flooringType: string;
  squareMetres?: number;
  notes?: string;
  exclusions?: string;
}

export interface AssignedTo {
  coordinator?: string;
  estimator?: string;
  crewLead?: string;
  finance?: string;
}

export interface Quote {
  versions: QuoteVersion[];
  approvedVersionId?: string;
  approvedBy?: string;
  approvedAt?: Date;
}

export interface Proof {
  photos: ProofPhoto[];
  capturedAt?: Date;
  capturedBy?: string;
  substrateNotes?: string;
  complete: boolean;
}

export interface Invoice {
  packetReady: boolean;
  sentAt?: Date;
  paidAt?: Date;
  amount?: number;
}

export interface SLA {
  leadDue: Date;
  quoteDue?: Date;
  invoiceDue?: Date;
  breached: boolean;
  breachedAt?: Date;
}

export interface JobPassport {
  jobRef: string; // VF-2026-0001 format
  retailer: Retailer;
  customer: Customer;
  scope: Scope;
  stage: Stage;
  stageHistory: StageEvent[];
  assignedTo: AssignedTo;
  quote: Quote;
  proof: Proof;
  invoice: Invoice;
  sla: SLA;
  exceptions: Exception[];
  createdAt: Date;
  updatedAt: Date;
}
