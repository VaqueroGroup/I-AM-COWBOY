import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { supabase } from '../db/supabase';
import { checkPassportExceptions } from '../events/webhook.handler';
import type { Stage } from '../types/passport';

const router = Router();

// ============================================================
// Zod Schemas
// ============================================================

const RetailerSchema = z.object({
  name: z.string().min(1),
  contactNumber: z.string().min(1),
  jobRefFormat: z.string().optional(),
  preferredChannel: z.enum(['sms', 'email']),
  sourceNumber: z.string().min(1),
});

const CustomerSchema = z.object({
  name: z.string().min(1),
  address: z.string().min(1),
  phone: z.string().min(1),
  email: z.string().email().optional(),
});

const ScopeSchema = z.object({
  flooringType: z.string().min(1),
  squareMetres: z.number().positive().optional(),
  notes: z.string().optional(),
  exclusions: z.string().optional(),
});

const SLASchema = z.object({
  leadDue: z.string().datetime(),
  quoteDue: z.string().datetime().optional(),
  invoiceDue: z.string().datetime().optional(),
});

const AssignedToSchema = z.object({
  coordinator: z.string().optional(),
  estimator: z.string().optional(),
  crewLead: z.string().optional(),
  finance: z.string().optional(),
});

const CreatePassportSchema = z.object({
  retailer: RetailerSchema,
  customer: CustomerSchema,
  scope: ScopeSchema,
  sla: SLASchema,
  assignedTo: AssignedToSchema.optional(),
});

const AdvanceStageSchema = z.object({
  stage: z.enum(['intake', 'measure', 'quote', 'install', 'invoice', 'complete']),
  actor: z.string().min(1),
  notes: z.string().optional(),
  automated: z.boolean().default(false),
});

const LogEventSchema = z.object({
  stage: z.string().min(1),
  actor: z.string().min(1),
  notes: z.string().optional(),
  automated: z.boolean().default(false),
});

const RaiseExceptionSchema = z.object({
  type: z.enum(['sla_breach', 'proof_missing', 'no_response', 'change_order', 'stage_stall', 'unassigned']),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  escalatedTo: z.string().optional(),
});

const ResolveExceptionSchema = z.object({
  resolution: z.string().min(1),
});

const AttachProofSchema = z.object({
  url: z.string().url(),
  type: z.enum(['before', 'during', 'after']),
  capturedBy: z.string().min(1),
  substrateNotes: z.string().optional(),
});

const QuoteVersionSchema = z.object({
  amount: z.number().positive(),
  scope: z.string().min(1),
  status: z.enum(['draft', 'sent', 'approved', 'rejected']),
  approvedBy: z.string().optional(),
});

// ============================================================
// Helpers
// ============================================================

function generateJobRef(): string {
  const year = new Date().getFullYear();
  const seq = Math.floor(Math.random() * 9999) + 1;
  return `VF-${year}-${seq.toString().padStart(4, '0')}`;
}

function zodValidate<T>(schema: z.ZodSchema<T>) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const error = new Error('Validation failed') as Error & { status: number; details: z.ZodIssue[] };
      error.status = 400;
      error.details = result.error.issues;
      next(error);
      return;
    }
    req.body = result.data;
    next();
  };
}

// ============================================================
// Routes
// ============================================================

// POST /api/v1/passports — create from retailer intake
router.post(
  '/',
  zodValidate(CreatePassportSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body = req.body as z.infer<typeof CreatePassportSchema>;
      const jobRef = generateJobRef();

      const passport = {
        job_ref: jobRef,
        retailer: body.retailer,
        customer: body.customer,
        scope: body.scope,
        stage: 'intake' as Stage,
        stage_history: [{
          id: crypto.randomUUID(),
          stage: 'intake',
          timestamp: new Date().toISOString(),
          actor: 'system',
          notes: 'Job created from retailer intake',
          automated: true,
        }],
        assigned_to: body.assignedTo ?? {},
        quote: { versions: [] },
        proof: { photos: [], complete: false },
        invoice: { packetReady: false },
        sla: { ...body.sla, breached: false },
        exceptions: [],
      };

      const { data, error } = await supabase
        .from('passports')
        .insert(passport)
        .select()
        .single();

      if (error) {
        next(error);
        return;
      }

      // Log the creation event
      await supabase.from('events').insert({
        job_ref: jobRef,
        stage: 'intake',
        actor: 'system',
        notes: 'Job passport created',
        automated: true,
      });

      // Fire webhook checks
      await checkPassportExceptions(data);

      res.status(201).json({ jobRef, passport: data });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/passports — list active (stage != complete)
router.get(
  '/',
  async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { data, error } = await supabase
        .from('passports')
        .select('*')
        .neq('stage', 'complete')
        .order('created_at', { ascending: false });

      if (error) {
        next(error);
        return;
      }

      res.json({ passports: data, count: data.length });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/passports/exceptions — all open exceptions
router.get(
  '/exceptions',
  async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { data, error } = await supabase
        .from('exceptions')
        .select('*')
        .is('resolved_at', null)
        .order('detected_at', { ascending: false });

      if (error) {
        next(error);
        return;
      }

      res.json({ exceptions: data, count: data.length });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/passports/:jobRef — get single passport
router.get(
  '/:jobRef',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { jobRef } = req.params;

      const { data, error } = await supabase
        .from('passports')
        .select('*')
        .eq('job_ref', jobRef)
        .single();

      if (error) {
        if (error.code === 'PGRST116') {
          res.status(404).json({ error: `Passport ${jobRef} not found` });
          return;
        }
        next(error);
        return;
      }

      res.json({ passport: data });
    } catch (err) {
      next(err);
    }
  }
);

// PUT /api/v1/passports/:jobRef/stage — advance stage
router.put(
  '/:jobRef/stage',
  zodValidate(AdvanceStageSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { jobRef } = req.params;
      const body = req.body as z.infer<typeof AdvanceStageSchema>;

      // Get current passport
      const { data: current, error: fetchError } = await supabase
        .from('passports')
        .select('*')
        .eq('job_ref', jobRef)
        .single();

      if (fetchError) {
        if (fetchError.code === 'PGRST116') {
          res.status(404).json({ error: `Passport ${jobRef} not found` });
          return;
        }
        next(fetchError);
        return;
      }

      const stageEvent = {
        id: crypto.randomUUID(),
        stage: body.stage,
        timestamp: new Date().toISOString(),
        actor: body.actor,
        notes: body.notes,
        automated: body.automated,
      };

      const updatedHistory = [...(current.stage_history as unknown[]), stageEvent];

      const { data, error } = await supabase
        .from('passports')
        .update({
          stage: body.stage,
          stage_history: updatedHistory,
        })
        .eq('job_ref', jobRef)
        .select()
        .single();

      if (error) {
        next(error);
        return;
      }

      // Log event
      await supabase.from('events').insert({
        job_ref: jobRef,
        stage: body.stage,
        actor: body.actor,
        notes: body.notes ?? `Stage advanced to ${body.stage}`,
        automated: body.automated,
      });

      // Fire webhook checks
      await checkPassportExceptions(data);

      res.json({ passport: data });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/passports/:jobRef/event — log any event
router.post(
  '/:jobRef/event',
  zodValidate(LogEventSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { jobRef } = req.params;
      const body = req.body as z.infer<typeof LogEventSchema>;

      // Verify passport exists
      const { error: fetchError } = await supabase
        .from('passports')
        .select('job_ref')
        .eq('job_ref', jobRef)
        .single();

      if (fetchError) {
        if (fetchError.code === 'PGRST116') {
          res.status(404).json({ error: `Passport ${jobRef} not found` });
          return;
        }
        next(fetchError);
        return;
      }

      const { data, error } = await supabase
        .from('events')
        .insert({
          job_ref: jobRef,
          stage: body.stage,
          actor: body.actor,
          notes: body.notes,
          automated: body.automated,
        })
        .select()
        .single();

      if (error) {
        next(error);
        return;
      }

      res.status(201).json({ event: data });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/passports/:jobRef/exception — raise exception
router.post(
  '/:jobRef/exception',
  zodValidate(RaiseExceptionSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { jobRef } = req.params;
      const body = req.body as z.infer<typeof RaiseExceptionSchema>;

      // Verify passport exists
      const { error: fetchError } = await supabase
        .from('passports')
        .select('job_ref')
        .eq('job_ref', jobRef)
        .single();

      if (fetchError) {
        if (fetchError.code === 'PGRST116') {
          res.status(404).json({ error: `Passport ${jobRef} not found` });
          return;
        }
        next(fetchError);
        return;
      }

      const { data, error } = await supabase
        .from('exceptions')
        .insert({
          job_ref: jobRef,
          type: body.type,
          severity: body.severity,
          escalated_to: body.escalatedTo,
        })
        .select()
        .single();

      if (error) {
        next(error);
        return;
      }

      // Also update passport's embedded exceptions array
      const { data: passport } = await supabase
        .from('passports')
        .select('exceptions')
        .eq('job_ref', jobRef)
        .single();

      if (passport) {
        const exceptions = [...(passport.exceptions as unknown[]), {
          id: data.id,
          type: body.type,
          severity: body.severity,
          detectedAt: data.detected_at,
          escalatedTo: body.escalatedTo,
        }];

        await supabase
          .from('passports')
          .update({ exceptions })
          .eq('job_ref', jobRef);
      }

      res.status(201).json({ exception: data });
    } catch (err) {
      next(err);
    }
  }
);

// PUT /api/v1/passports/:jobRef/exception/:id — resolve exception
router.put(
  '/:jobRef/exception/:id',
  zodValidate(ResolveExceptionSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { jobRef, id } = req.params;
      const body = req.body as z.infer<typeof ResolveExceptionSchema>;

      const { data, error } = await supabase
        .from('exceptions')
        .update({
          resolved_at: new Date().toISOString(),
          resolution: body.resolution,
        })
        .eq('id', id)
        .eq('job_ref', jobRef)
        .select()
        .single();

      if (error) {
        if (error.code === 'PGRST116') {
          res.status(404).json({ error: `Exception ${id} not found for ${jobRef}` });
          return;
        }
        next(error);
        return;
      }

      // Update passport's embedded exceptions array
      const { data: passport } = await supabase
        .from('passports')
        .select('exceptions')
        .eq('job_ref', jobRef)
        .single();

      if (passport) {
        const exceptions = (passport.exceptions as Array<{ id: string }>).map((exc) =>
          exc.id === id
            ? { ...exc, resolvedAt: data.resolved_at, resolution: body.resolution }
            : exc
        );

        await supabase
          .from('passports')
          .update({ exceptions })
          .eq('job_ref', jobRef);
      }

      res.json({ exception: data });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/passports/:jobRef/proof — attach proof
router.post(
  '/:jobRef/proof',
  zodValidate(AttachProofSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { jobRef } = req.params;
      const body = req.body as z.infer<typeof AttachProofSchema>;

      const { data: passport, error: fetchError } = await supabase
        .from('passports')
        .select('proof')
        .eq('job_ref', jobRef)
        .single();

      if (fetchError) {
        if (fetchError.code === 'PGRST116') {
          res.status(404).json({ error: `Passport ${jobRef} not found` });
          return;
        }
        next(fetchError);
        return;
      }

      const currentProof = passport.proof as {
        photos: unknown[];
        complete: boolean;
        capturedBy?: string;
        substrateNotes?: string;
      };

      const newPhoto = {
        id: crypto.randomUUID(),
        url: body.url,
        type: body.type,
        capturedAt: new Date().toISOString(),
      };

      const photos = [...currentProof.photos, newPhoto];
      const hasAllTypes = ['before', 'during', 'after'].every((t) =>
        photos.some((p) => (p as { type: string }).type === t)
      );

      const updatedProof = {
        photos,
        capturedAt: new Date().toISOString(),
        capturedBy: body.capturedBy,
        substrateNotes: body.substrateNotes ?? currentProof.substrateNotes,
        complete: hasAllTypes,
      };

      const { data, error } = await supabase
        .from('passports')
        .update({ proof: updatedProof })
        .eq('job_ref', jobRef)
        .select()
        .single();

      if (error) {
        next(error);
        return;
      }

      // Fire webhook checks
      await checkPassportExceptions(data);

      res.status(201).json({ photo: newPhoto, proof: updatedProof });
    } catch (err) {
      next(err);
    }
  }
);

// PUT /api/v1/passports/:jobRef/quote — create/update quote version
router.put(
  '/:jobRef/quote',
  zodValidate(QuoteVersionSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { jobRef } = req.params;
      const body = req.body as z.infer<typeof QuoteVersionSchema>;

      const { data: passport, error: fetchError } = await supabase
        .from('passports')
        .select('quote')
        .eq('job_ref', jobRef)
        .single();

      if (fetchError) {
        if (fetchError.code === 'PGRST116') {
          res.status(404).json({ error: `Passport ${jobRef} not found` });
          return;
        }
        next(fetchError);
        return;
      }

      const currentQuote = passport.quote as {
        versions: unknown[];
        approvedVersionId?: string;
        approvedBy?: string;
        approvedAt?: string;
      };

      const newVersion = {
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        amount: body.amount,
        scope: body.scope,
        status: body.status,
      };

      const versions = [...currentQuote.versions, newVersion];

      const updatedQuote = {
        versions,
        approvedVersionId: body.status === 'approved' ? newVersion.id : currentQuote.approvedVersionId,
        approvedBy: body.status === 'approved' ? body.approvedBy : currentQuote.approvedBy,
        approvedAt: body.status === 'approved' ? new Date().toISOString() : currentQuote.approvedAt,
      };

      const { data, error } = await supabase
        .from('passports')
        .update({ quote: updatedQuote })
        .eq('job_ref', jobRef)
        .select()
        .single();

      if (error) {
        next(error);
        return;
      }

      // Fire webhook checks (change order detection)
      await checkPassportExceptions(data);

      res.json({ version: newVersion, quote: updatedQuote });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
