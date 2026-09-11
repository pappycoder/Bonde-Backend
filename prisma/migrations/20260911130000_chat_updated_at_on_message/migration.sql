-- Function + trigger: stamp chats.updated_at whenever a message is inserted,
-- using the message's own timestamp so the chat reflects the last message time.
CREATE OR REPLACE FUNCTION touch_chat_updated_at_on_message() RETURNS trigger AS $$
BEGIN
  UPDATE chats SET updated_at = NEW.created_at WHERE id = NEW.chat_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER chats_updated_at_on_message
AFTER INSERT ON messages
FOR EACH ROW EXECUTE FUNCTION touch_chat_updated_at_on_message();
