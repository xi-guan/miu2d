-- ============================================================
-- Fix NPC/OBJ scene key mismatches
-- Generated from check-npc-map-mismatch.py results
--
-- For each file stored under the wrong scene (via Map= field),
-- copy it to the scene where scripts actually use it.
-- ============================================================

BEGIN;

-- ============================================================
-- sword2 (d9eacebb-619c-46b8-ab92-c3ae47429eb6)
-- ============================================================

-- 1. Fengci1.npc: 凤池山庄夜战 → 凤池山庄
UPDATE scenes dst
SET data = jsonb_set(
  jsonb_set(COALESCE(dst.data, '{}'::jsonb), '{npc}', COALESCE(dst.data->'npc', '{}'::jsonb)),
  ARRAY['npc', 'fengci1.npc'],
  (SELECT src.data->'npc'->'fengci1.npc' FROM scenes src
   WHERE src.game_id = dst.game_id AND src.key = '凤池山庄夜战'),
  true
)
WHERE dst.game_id = 'd9eacebb-619c-46b8-ab92-c3ae47429eb6' AND dst.key = '凤池山庄';

-- 2. None.npc: 大牢出口 → 大牢出口1
UPDATE scenes dst
SET data = jsonb_set(
  jsonb_set(COALESCE(dst.data, '{}'::jsonb), '{npc}', COALESCE(dst.data->'npc', '{}'::jsonb)),
  ARRAY['npc', 'none.npc'],
  (SELECT src.data->'npc'->'none.npc' FROM scenes src
   WHERE src.game_id = dst.game_id AND src.key = '大牢出口'),
  true
)
WHERE dst.game_id = 'd9eacebb-619c-46b8-ab92-c3ae47429eb6' AND dst.key = '大牢出口1';

-- 3. DaLaoChuKou.obj: 大牢出口 → 大牢出口1
UPDATE scenes dst
SET data = jsonb_set(
  jsonb_set(COALESCE(dst.data, '{}'::jsonb), '{obj}', COALESCE(dst.data->'obj', '{}'::jsonb)),
  ARRAY['obj', 'dalaochukou.obj'],
  (SELECT src.data->'obj'->'dalaochukou.obj' FROM scenes src
   WHERE src.game_id = dst.game_id AND src.key = '大牢出口'),
  true
)
WHERE dst.game_id = 'd9eacebb-619c-46b8-ab92-c3ae47429eb6' AND dst.key = '大牢出口1';

-- 4. KS.Obj: 狂沙镇 → 狂沙镇夜
UPDATE scenes dst
SET data = jsonb_set(
  jsonb_set(COALESCE(dst.data, '{}'::jsonb), '{obj}', COALESCE(dst.data->'obj', '{}'::jsonb)),
  ARRAY['obj', 'ks.obj'],
  (SELECT src.data->'obj'->'ks.obj' FROM scenes src
   WHERE src.game_id = dst.game_id AND src.key = '狂沙镇'),
  true
)
WHERE dst.game_id = 'd9eacebb-619c-46b8-ab92-c3ae47429eb6' AND dst.key = '狂沙镇夜';

-- 5. tmz.npc: 天王岛 → 铁门寨
UPDATE scenes dst
SET data = jsonb_set(
  jsonb_set(COALESCE(dst.data, '{}'::jsonb), '{npc}', COALESCE(dst.data->'npc', '{}'::jsonb)),
  ARRAY['npc', 'tmz.npc'],
  (SELECT src.data->'npc'->'tmz.npc' FROM scenes src
   WHERE src.game_id = dst.game_id AND src.key = '天王岛'),
  true
)
WHERE dst.game_id = 'd9eacebb-619c-46b8-ab92-c3ae47429eb6' AND dst.key = '铁门寨';

-- ============================================================
-- sword1 (004913e4-54e5-4932-8844-56b4e3eccf11)
-- ============================================================

-- 6. map001.npc: map001_衡山 → map118_泰山
UPDATE scenes dst
SET data = jsonb_set(
  jsonb_set(COALESCE(dst.data, '{}'::jsonb), '{npc}', COALESCE(dst.data->'npc', '{}'::jsonb)),
  ARRAY['npc', 'map001.npc'],
  (SELECT src.data->'npc'->'map001.npc' FROM scenes src
   WHERE src.game_id = dst.game_id AND src.key = 'map001_衡山'),
  true
)
WHERE dst.game_id = '004913e4-54e5-4932-8844-56b4e3eccf11' AND dst.key = 'map118_泰山';

-- 7. map001.obj: map001_衡山 → map118_泰山
UPDATE scenes dst
SET data = jsonb_set(
  jsonb_set(COALESCE(dst.data, '{}'::jsonb), '{obj}', COALESCE(dst.data->'obj', '{}'::jsonb)),
  ARRAY['obj', 'map001.obj'],
  (SELECT src.data->'obj'->'map001.obj' FROM scenes src
   WHERE src.game_id = dst.game_id AND src.key = 'map001_衡山'),
  true
)
WHERE dst.game_id = '004913e4-54e5-4932-8844-56b4e3eccf11' AND dst.key = 'map118_泰山';

-- 8. map038.obj: false positive (map038_碧霞岛山洞 vs map038_碧霞岛山洞.map — same key after strip)
--    SKIP

-- 9. map075.obj: map075_韩世忠库房 → map085_朱仙镇客栈
UPDATE scenes dst
SET data = jsonb_set(
  jsonb_set(COALESCE(dst.data, '{}'::jsonb), '{obj}', COALESCE(dst.data->'obj', '{}'::jsonb)),
  ARRAY['obj', 'map075.obj'],
  (SELECT src.data->'obj'->'map075.obj' FROM scenes src
   WHERE src.game_id = dst.game_id AND src.key = 'map075_韩世忠库房'),
  true
)
WHERE dst.game_id = '004913e4-54e5-4932-8844-56b4e3eccf11' AND dst.key = 'map085_朱仙镇客栈';

-- 10. map113.npc: map113_五剑堂正厅 → map113_五剑堂正厅-1
UPDATE scenes dst
SET data = jsonb_set(
  jsonb_set(COALESCE(dst.data, '{}'::jsonb), '{npc}', COALESCE(dst.data->'npc', '{}'::jsonb)),
  ARRAY['npc', 'map113.npc'],
  (SELECT src.data->'npc'->'map113.npc' FROM scenes src
   WHERE src.game_id = dst.game_id AND src.key = 'map113_五剑堂正厅'),
  true
)
WHERE dst.game_id = '004913e4-54e5-4932-8844-56b4e3eccf11' AND dst.key = 'map113_五剑堂正厅-1';

-- ============================================================
-- demo (1853d824-ceae-4d56-8790-c7079513b802)
-- ============================================================

-- 11. map040_obj.obj: not in DB, has Count=0 → insert empty entries into map_040_沙漠
UPDATE scenes dst
SET data = jsonb_set(
  jsonb_set(COALESCE(dst.data, '{}'::jsonb), '{obj}', COALESCE(dst.data->'obj', '{}'::jsonb)),
  ARRAY['obj', 'map040_obj.obj'],
  '{"key": "map040_obj.obj", "entries": []}'::jsonb,
  true
)
WHERE dst.game_id = '1853d824-ceae-4d56-8790-c7079513b802' AND dst.key = 'map_040_沙漠';

-- 12. map019.npc: map_019_寒波谷 → map_019_寒波谷(A)
UPDATE scenes dst
SET data = jsonb_set(
  jsonb_set(COALESCE(dst.data, '{}'::jsonb), '{npc}', COALESCE(dst.data->'npc', '{}'::jsonb)),
  ARRAY['npc', 'map019.npc'],
  (SELECT src.data->'npc'->'map019.npc' FROM scenes src
   WHERE src.game_id = dst.game_id AND src.key = 'map_019_寒波谷'),
  true
)
WHERE dst.game_id = '1853d824-ceae-4d56-8790-c7079513b802' AND dst.key = 'map_019_寒波谷(A)';

-- 13. map019.npc: map_019_寒波谷 → map_019_寒波谷(B)
UPDATE scenes dst
SET data = jsonb_set(
  jsonb_set(COALESCE(dst.data, '{}'::jsonb), '{npc}', COALESCE(dst.data->'npc', '{}'::jsonb)),
  ARRAY['npc', 'map019.npc'],
  (SELECT src.data->'npc'->'map019.npc' FROM scenes src
   WHERE src.game_id = dst.game_id AND src.key = 'map_019_寒波谷'),
  true
)
WHERE dst.game_id = '1853d824-ceae-4d56-8790-c7079513b802' AND dst.key = 'map_019_寒波谷(B)';

-- 14. map019_obj.obj: map_019_寒波谷 → map_019_寒波谷(B)
UPDATE scenes dst
SET data = jsonb_set(
  jsonb_set(COALESCE(dst.data, '{}'::jsonb), '{obj}', COALESCE(dst.data->'obj', '{}'::jsonb)),
  ARRAY['obj', 'map019_obj.obj'],
  (SELECT src.data->'obj'->'map019_obj.obj' FROM scenes src
   WHERE src.game_id = dst.game_id AND src.key = 'map_019_寒波谷'),
  true
)
WHERE dst.game_id = '1853d824-ceae-4d56-8790-c7079513b802' AND dst.key = 'map_019_寒波谷(B)';

-- 15. map030_obj.obj: map_030_悲魔山庄 → map_039_飞龙堡
UPDATE scenes dst
SET data = jsonb_set(
  jsonb_set(COALESCE(dst.data, '{}'::jsonb), '{obj}', COALESCE(dst.data->'obj', '{}'::jsonb)),
  ARRAY['obj', 'map030_obj.obj'],
  (SELECT src.data->'obj'->'map030_obj.obj' FROM scenes src
   WHERE src.game_id = dst.game_id AND src.key = 'map_030_悲魔山庄'),
  true
)
WHERE dst.game_id = '1853d824-ceae-4d56-8790-c7079513b802' AND dst.key = 'map_039_飞龙堡';

-- 16. map030_obj.obj: map_030_悲魔山庄 → map_051_海边
UPDATE scenes dst
SET data = jsonb_set(
  jsonb_set(COALESCE(dst.data, '{}'::jsonb), '{obj}', COALESCE(dst.data->'obj', '{}'::jsonb)),
  ARRAY['obj', 'map030_obj.obj'],
  (SELECT src.data->'obj'->'map030_obj.obj' FROM scenes src
   WHERE src.game_id = dst.game_id AND src.key = 'map_030_悲魔山庄'),
  true
)
WHERE dst.game_id = '1853d824-ceae-4d56-8790-c7079513b802' AND dst.key = 'map_051_海边';

-- 17. beimo.npc: map_030_悲魔山庄 → map_039_飞龙堡
UPDATE scenes dst
SET data = jsonb_set(
  jsonb_set(COALESCE(dst.data, '{}'::jsonb), '{npc}', COALESCE(dst.data->'npc', '{}'::jsonb)),
  ARRAY['npc', 'beimo.npc'],
  (SELECT src.data->'npc'->'beimo.npc' FROM scenes src
   WHERE src.game_id = dst.game_id AND src.key = 'map_030_悲魔山庄'),
  true
)
WHERE dst.game_id = '1853d824-ceae-4d56-8790-c7079513b802' AND dst.key = 'map_039_飞龙堡';

-- 18. beimo.npc: map_030_悲魔山庄 → map_051_海边
UPDATE scenes dst
SET data = jsonb_set(
  jsonb_set(COALESCE(dst.data, '{}'::jsonb), '{npc}', COALESCE(dst.data->'npc', '{}'::jsonb)),
  ARRAY['npc', 'beimo.npc'],
  (SELECT src.data->'npc'->'beimo.npc' FROM scenes src
   WHERE src.game_id = dst.game_id AND src.key = 'map_030_悲魔山庄'),
  true
)
WHERE dst.game_id = '1853d824-ceae-4d56-8790-c7079513b802' AND dst.key = 'map_051_海边';

-- 19. map030_Evt3110.npc (stored with mixed case): map_030_悲魔山庄 → map_051_海边
--     Copy using exact source key, store under lowercase key in target
UPDATE scenes dst
SET data = jsonb_set(
  jsonb_set(COALESCE(dst.data, '{}'::jsonb), '{npc}', COALESCE(dst.data->'npc', '{}'::jsonb)),
  ARRAY['npc', 'map030_evt3110.npc'],
  (SELECT jsonb_build_object('key', 'map030_evt3110.npc', 'entries', (je.val->'entries'))
   FROM scenes src, jsonb_each(src.data->'npc') je(k, val)
   WHERE src.game_id = dst.game_id AND src.key = 'map_030_悲魔山庄'
     AND lower(je.k) = 'map030_evt3110.npc'
   LIMIT 1),
  true
)
WHERE dst.game_id = '1853d824-ceae-4d56-8790-c7079513b802' AND dst.key = 'map_051_海边';

-- 20. map030_Dream.npc (stored with mixed case): map_030_悲魔山庄 → map_051_海边
UPDATE scenes dst
SET data = jsonb_set(
  jsonb_set(COALESCE(dst.data, '{}'::jsonb), '{npc}', COALESCE(dst.data->'npc', '{}'::jsonb)),
  ARRAY['npc', 'map030_dream.npc'],
  (SELECT jsonb_build_object('key', 'map030_dream.npc', 'entries', (je.val->'entries'))
   FROM scenes src, jsonb_each(src.data->'npc') je(k, val)
   WHERE src.game_id = dst.game_id AND src.key = 'map_030_悲魔山庄'
     AND lower(je.k) = 'map030_dream.npc'
   LIMIT 1),
  true
)
WHERE dst.game_id = '1853d824-ceae-4d56-8790-c7079513b802' AND dst.key = 'map_051_海边';

-- 21. map056.npc: map_056_盆地 → map_056_盆地加坟墓
UPDATE scenes dst
SET data = jsonb_set(
  jsonb_set(COALESCE(dst.data, '{}'::jsonb), '{npc}', COALESCE(dst.data->'npc', '{}'::jsonb)),
  ARRAY['npc', 'map056.npc'],
  (SELECT src.data->'npc'->'map056.npc' FROM scenes src
   WHERE src.game_id = dst.game_id AND src.key = 'map_056_盆地'),
  true
)
WHERE dst.game_id = '1853d824-ceae-4d56-8790-c7079513b802' AND dst.key = 'map_056_盆地加坟墓';

-- 22. map056_obj.obj: map_056_盆地 → map_056_盆地加坟墓
UPDATE scenes dst
SET data = jsonb_set(
  jsonb_set(COALESCE(dst.data, '{}'::jsonb), '{obj}', COALESCE(dst.data->'obj', '{}'::jsonb)),
  ARRAY['obj', 'map056_obj.obj'],
  (SELECT src.data->'obj'->'map056_obj.obj' FROM scenes src
   WHERE src.game_id = dst.game_id AND src.key = 'map_056_盆地'),
  true
)
WHERE dst.game_id = '1853d824-ceae-4d56-8790-c7079513b802' AND dst.key = 'map_056_盆地加坟墓';

-- 23. map064_bomb.npc: map_064_霹雳堂 → map_063_药王谷
UPDATE scenes dst
SET data = jsonb_set(
  jsonb_set(COALESCE(dst.data, '{}'::jsonb), '{npc}', COALESCE(dst.data->'npc', '{}'::jsonb)),
  ARRAY['npc', 'map064_bomb.npc'],
  (SELECT src.data->'npc'->'map064_bomb.npc' FROM scenes src
   WHERE src.game_id = dst.game_id AND src.key = 'map_064_霹雳堂'),
  true
)
WHERE dst.game_id = '1853d824-ceae-4d56-8790-c7079513b802' AND dst.key = 'map_063_药王谷';

COMMIT;
