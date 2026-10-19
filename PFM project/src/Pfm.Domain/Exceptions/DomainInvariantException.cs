using System;

namespace Pfm.Domain.Exceptions
{
    /// <summary>
    /// Thrown when a non-negotiable financial domain invariant is violated.
    /// Includes both English and Simplified Mandarin error messages.
    /// </summary>
    public class DomainInvariantException : Exception
    {
        public string ErrorCode { get; }
        public string MessageEn { get; }
        public string MessageZh { get; }

        public DomainInvariantException(string errorCode, string messageEn, string messageZh)
            : base($"{errorCode}: {messageEn} / {messageZh}")
        {
            ErrorCode = errorCode;
            MessageEn = messageEn;
            MessageZh = messageZh;
        }
    }
}

