"""Snapshot export/import roundtrip."""

from __future__ import annotations

from panini_service.snapshot import build_full_snapshot, import_album_snapshot


def test_snapshot_roundtrip_restores_inventory(db_conn):
    before = build_full_snapshot(db_conn)
    db_conn.execute(
        """
        UPDATE inventory SET qty = 0
        WHERE sticker_id = (SELECT id FROM stickers WHERE category_code = 'FWC' AND slot_code = '1')
        """
    )
    db_conn.commit()

    import_album_snapshot(db_conn, before, apply_session=True)
    db_conn.commit()

    after = build_full_snapshot(db_conn)
    assert after["stickers"] == before["stickers"]
    assert after["session"] == before["session"]


def test_import_without_session_skips_counters(db_conn):
    snap = build_full_snapshot(db_conn)
    snap.pop("session", None)
    db_conn.execute(
        """
        UPDATE inventory SET qty = 0
        WHERE sticker_id = (SELECT id FROM stickers WHERE category_code = 'MEX' AND slot_code = '5')
        """
    )
    db_conn.commit()

    r = import_album_snapshot(db_conn, snap, apply_session=True)
    assert any("no session" in w.lower() for w in r["warnings"])

    row = db_conn.execute(
        """
        SELECT i.qty FROM inventory i
        JOIN stickers s ON s.id = i.sticker_id
        WHERE s.category_code = 'MEX' AND s.slot_code = '5'
        """
    ).fetchone()
    assert int(row["qty"]) == 1
