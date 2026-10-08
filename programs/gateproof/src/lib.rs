use anchor_lang::prelude::*;

// Replace this template address with the deployed program address before deployment.
declare_id!("Fg6PaFpoGXkYsidMpWxTWqkZL7FEfcYkgMQhgB9qL5p");

#[program]
pub mod gateproof {
    use super::*;

    pub fn create_event(
        ctx: Context<CreateEvent>,
        event_id: [u8; 32],
        name_hash: [u8; 32],
        capacity: u32,
    ) -> Result<()> {
        require!(capacity > 0, GateProofError::InvalidCapacity);

        let event = &mut ctx.accounts.event;
        event.organizer = ctx.accounts.organizer.key();
        event.gate_authority = ctx.accounts.organizer.key();
        event.event_id = event_id;
        event.name_hash = name_hash;
        event.capacity = capacity;
        event.issued = 0;
        event.active = true;
        event.bump = ctx.bumps.event;

        emit!(EventCreated {
            event: event.key(),
            organizer: event.organizer,
            capacity,
        });
        Ok(())
    }

    pub fn issue_ticket(
        ctx: Context<IssueTicket>,
        ticket_id: [u8; 32],
        holder_commitment: [u8; 32],
    ) -> Result<()> {
        let event = &mut ctx.accounts.event;
        require!(event.active, GateProofError::EventInactive);
        require!(event.issued < event.capacity, GateProofError::CapacityReached);

        let ticket = &mut ctx.accounts.ticket;
        ticket.event = event.key();
        ticket.ticket_id = ticket_id;
        ticket.holder_commitment = holder_commitment;
        ticket.state = TicketState::Issued;
        ticket.bump = ctx.bumps.ticket;
        event.issued = event.issued.checked_add(1).ok_or(GateProofError::ArithmeticOverflow)?;

        emit!(TicketIssued {
            event: event.key(),
            ticket: ticket.key(),
            holder_commitment,
        });
        Ok(())
    }

    pub fn set_gate_authority(ctx: Context<OrganizerEventAction>, gate_authority: Pubkey) -> Result<()> {
        ctx.accounts.event.gate_authority = gate_authority;
        Ok(())
    }

    /// Organizer-approved transfer: attendee identifiers remain off-chain.
    pub fn transfer_ticket(
        ctx: Context<OrganizerTicketAction>,
        new_holder_commitment: [u8; 32],
    ) -> Result<()> {
        let ticket = &mut ctx.accounts.ticket;
        require!(ctx.accounts.event.active, GateProofError::EventInactive);
        require!(ticket.state == TicketState::Issued, GateProofError::TicketNotActive);
        let previous_holder_commitment = ticket.holder_commitment;
        ticket.holder_commitment = new_holder_commitment;

        emit!(TicketTransferred {
            event: ticket.event,
            ticket: ticket.key(),
            previous_holder_commitment,
            new_holder_commitment,
        });
        Ok(())
    }

    pub fn revoke_ticket(ctx: Context<OrganizerTicketAction>) -> Result<()> {
        let ticket = &mut ctx.accounts.ticket;
        require!(ticket.state == TicketState::Issued, GateProofError::TicketNotActive);
        ticket.state = TicketState::Revoked;
        emit!(TicketRevoked {
            event: ticket.event,
            ticket: ticket.key(),
        });
        Ok(())
    }

    /// The gate authority is set to the organizer when the event is created.
    /// A future instruction can rotate it to a dedicated scanner key.
    pub fn check_in(ctx: Context<GateCheckIn>) -> Result<()> {
        require!(ctx.accounts.event.active, GateProofError::EventInactive);
        require_keys_eq!(
            ctx.accounts.gate.key(),
            ctx.accounts.event.gate_authority,
            GateProofError::UnauthorizedGate
        );
        let ticket = &mut ctx.accounts.ticket;
        require!(ticket.state == TicketState::Issued, GateProofError::TicketNotActive);
        ticket.state = TicketState::CheckedIn;

        emit!(TicketCheckedIn {
            event: ticket.event,
            ticket: ticket.key(),
            gate: ctx.accounts.gate.key(),
        });
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(event_id: [u8; 32])]
pub struct CreateEvent<'info> {
    #[account(mut)]
    pub organizer: Signer<'info>,
    #[account(
        init,
        payer = organizer,
        space = 8 + Event::SPACE,
        seeds = [b"event", organizer.key().as_ref(), event_id.as_ref()],
        bump
    )]
    pub event: Account<'info, Event>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(ticket_id: [u8; 32])]
pub struct IssueTicket<'info> {
    #[account(mut)]
    pub organizer: Signer<'info>,
    #[account(
        mut,
        has_one = organizer,
        seeds = [b"event", organizer.key().as_ref(), event.event_id.as_ref()],
        bump = event.bump
    )]
    pub event: Account<'info, Event>,
    #[account(
        init,
        payer = organizer,
        space = 8 + Ticket::SPACE,
        seeds = [b"ticket", event.key().as_ref(), ticket_id.as_ref()],
        bump
    )]
    pub ticket: Account<'info, Ticket>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OrganizerTicketAction<'info> {
    pub organizer: Signer<'info>,
    #[account(
        has_one = organizer,
        seeds = [b"event", organizer.key().as_ref(), event.event_id.as_ref()],
        bump = event.bump
    )]
    pub event: Account<'info, Event>,
    #[account(
        mut,
        constraint = ticket.event == event.key() @ GateProofError::WrongEvent,
        seeds = [b"ticket", event.key().as_ref(), ticket.ticket_id.as_ref()],
        bump = ticket.bump
    )]
    pub ticket: Account<'info, Ticket>,
}

#[derive(Accounts)]
pub struct OrganizerEventAction<'info> {
    pub organizer: Signer<'info>,
    #[account(
        mut,
        has_one = organizer,
        seeds = [b"event", organizer.key().as_ref(), event.event_id.as_ref()],
        bump = event.bump
    )]
    pub event: Account<'info, Event>,
}

#[derive(Accounts)]
pub struct GateCheckIn<'info> {
    pub gate: Signer<'info>,
    #[account(
        seeds = [b"event", event.organizer.as_ref(), event.event_id.as_ref()],
        bump = event.bump
    )]
    pub event: Account<'info, Event>,
    #[account(
        mut,
        constraint = ticket.event == event.key() @ GateProofError::WrongEvent,
        seeds = [b"ticket", event.key().as_ref(), ticket.ticket_id.as_ref()],
        bump = ticket.bump
    )]
    pub ticket: Account<'info, Ticket>,
}

#[account]
pub struct Event {
    pub organizer: Pubkey,
    pub gate_authority: Pubkey,
    pub event_id: [u8; 32],
    pub name_hash: [u8; 32],
    pub capacity: u32,
    pub issued: u32,
    pub active: bool,
    pub bump: u8,
}

impl Event {
    pub const SPACE: usize = 32 + 32 + 32 + 32 + 4 + 4 + 1 + 1;
}

#[account]
pub struct Ticket {
    pub event: Pubkey,
    pub ticket_id: [u8; 32],
    pub holder_commitment: [u8; 32],
    pub state: TicketState,
    pub bump: u8,
}

impl Ticket {
    pub const SPACE: usize = 32 + 32 + 32 + 1 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum TicketState {
    Issued,
    CheckedIn,
    Revoked,
}

#[event]
pub struct EventCreated {
    pub event: Pubkey,
    pub organizer: Pubkey,
    pub capacity: u32,
}

#[event]
pub struct TicketIssued {
    pub event: Pubkey,
    pub ticket: Pubkey,
    pub holder_commitment: [u8; 32],
}

#[event]
pub struct TicketTransferred {
    pub event: Pubkey,
    pub ticket: Pubkey,
    pub previous_holder_commitment: [u8; 32],
    pub new_holder_commitment: [u8; 32],
}

#[event]
pub struct TicketRevoked {
    pub event: Pubkey,
    pub ticket: Pubkey,
}

#[event]
pub struct TicketCheckedIn {
    pub event: Pubkey,
    pub ticket: Pubkey,
    pub gate: Pubkey,
}

#[error_code]
pub enum GateProofError {
    #[msg("Capacity must be greater than zero.")]
    InvalidCapacity,
    #[msg("The event is inactive.")]
    EventInactive,
    #[msg("The event has no remaining ticket capacity.")]
    CapacityReached,
    #[msg("The ticket is no longer active.")]
    TicketNotActive,
    #[msg("This gate is not authorized for the event.")]
    UnauthorizedGate,
    #[msg("The ticket belongs to another event.")]
    WrongEvent,
    #[msg("A counter exceeded its supported range.")]
    ArithmeticOverflow,
}
