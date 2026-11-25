package store

import "github.com/xpanp/qqsg-fighting/backend/internal/processing"

// Called by the single serving process only, never by backup/import CLI commands.
func (s *Store) PrepareWorker() error {
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec(`UPDATE jobs SET status='queued' WHERE status='running'`); err != nil {
		return err
	}
	var algorithm string
	if err = tx.QueryRow(`SELECT value FROM meta WHERE key='published_algorithm'`).Scan(&algorithm); err != nil {
		return err
	}
	if algorithm != processing.AlgorithmVersion {
		if _, err = jobTx(tx, 0, 0, true); err != nil {
			return err
		}
	}
	return tx.Commit()
}
