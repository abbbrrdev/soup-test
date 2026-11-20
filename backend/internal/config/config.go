package config

import (
	"os"
)

type Config struct {
	DatabaseURL string
	Port        string
}

func Load() Config {
	return Config{
		DatabaseURL: getenv("DATABASE_URL", "postgres://tracker:tracker@localhost:5432/tracker?sslmode=disable"),
		Port:        getenv("PORT", "8080"),
	}
}

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
