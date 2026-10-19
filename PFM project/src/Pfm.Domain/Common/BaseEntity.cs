using System;

namespace Pfm.Domain.Common
{
    /// <summary>
    /// Base domain entity with unique identifier and audit timestamps.
    /// </summary>
    public abstract class BaseEntity
    {
        public Guid Id { get; set; } = Guid.NewGuid();
        public DateTime CreatedAtUtc { get; set; } = DateTime.UtcNow;
        public DateTime? UpdatedAtUtc { get; set; }
    }

    /// <summary>
    /// Represents a bilingual (English & Simplified Mandarin) display name with optional translation key.
    /// </summary>
    public class BilingualEntity : BaseEntity
    {
        public string NameEn { get; set; } = string.Empty;
        public string NameZh { get; set; } = string.Empty;
        public string? TranslationKey { get; set; }

        public string GetLocalizedName(string languageCode)
        {
            if (!string.IsNullOrWhiteSpace(languageCode) &&
                languageCode.StartsWith("zh", StringComparison.OrdinalIgnoreCase))
            {
                return !string.IsNullOrWhiteSpace(NameZh) ? NameZh : NameEn;
            }
            return !string.IsNullOrWhiteSpace(NameEn) ? NameEn : NameZh;
        }
    }
}

