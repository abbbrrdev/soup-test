-- LOCAL DEMO DATA ONLY.
-- Project A demo key (plaintext): sk_demo_project_a_local_only_0000
-- Project B demo key (plaintext): sk_demo_project_b_local_only_0000
INSERT INTO projects (id, name) VALUES
    ('00000000-0000-0000-0000-00000000000a', 'Demo Project A (local)'),
    ('00000000-0000-0000-0000-00000000000b', 'Demo Project B (local)');

INSERT INTO api_keys (project_id, key_hash, key_prefix) VALUES
    ('00000000-0000-0000-0000-00000000000a',
     '9b122ad7e58f9795d712c630e43ce3a04f586d072621a2c8566c6c90f38941eb',
     'sk_demo_pro'),
    ('00000000-0000-0000-0000-00000000000b',
     '7c7c68233d5bd2ca2e1af82375fcfc4373fe2039d29149b703851591ce2217e5',
     'sk_demo_pro');
