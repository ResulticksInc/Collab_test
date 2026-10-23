// Unified Connector Engine — platform → adapter lookup.
import { googleCalendarAdapter } from "./adapters/googleCalendar";
import { googleChatAdapter } from "./adapters/googleChat";
import { outlookCalendarAdapter } from "./adapters/outlookCalendar";
import { slackAdapter } from "./adapters/slack";
import { teamsAdapter } from "./adapters/teams";
import { whatsappAdapter } from "./adapters/whatsapp";
import { type CalendarAdapter, type ChatAdapter, type Platform } from "./types";

const chat: Partial<Record<Platform, ChatAdapter>> = {
  slack: slackAdapter,
  teams: teamsAdapter,
  google_chat: googleChatAdapter,
  whatsapp: whatsappAdapter,
};

const calendar: Partial<Record<Platform, CalendarAdapter>> = {
  google_calendar: googleCalendarAdapter,
  outlook_calendar: outlookCalendarAdapter,
};

export function getChatAdapter(platform: string): ChatAdapter | null {
  return (chat as any)[platform] || null;
}

export function getCalendarAdapter(platform: string): CalendarAdapter | null {
  return (calendar as any)[platform] || null;
}
