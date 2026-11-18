ALTER TABLE "subscription_reminders"
  DROP CONSTRAINT "subscription_reminders_service_check",
  ADD CONSTRAINT "subscription_reminders_service_check"
    CHECK ("service_id" IN (
      'netflix', 'spotify', 'youtube-premium', 'apple-music', 'prime-video', 'google-one',
      'microsoft-365', 'canva-pro', 'adobe-creative-cloud'
    ));
