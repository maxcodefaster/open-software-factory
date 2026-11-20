-- Pre-table routines retain forward references to table row types and SQL relations.
-- Run after schemas/extensions/enum types and before the *-functions.sql files.

SET check_function_bodies = false;
